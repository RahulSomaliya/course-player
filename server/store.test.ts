import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { KeyedMutex, ProgressStore, pickNewer, readJsonFile, validateProgress, writeFileAtomic } from './store.ts';
import { makeTempDir, memoryLog, progress } from './test-helpers.ts';


let dir = '';
let cleanup: () => Promise<void> = async () => {};
beforeEach(async () => {
  ({ dir, cleanup } = await makeTempDir('store'));
});
afterEach(() => cleanup());

describe('writeFileAtomic', () => {
  it('writes via <file>.tmp + rename and leaves no temp file behind', async () => {
    const file = path.join(dir, 'progress-rahul.json');
    await writeFile(file, 'old');
    await writeFileAtomic(file, '{"new":true}');
    expect(await readFile(file, 'utf8')).toBe('{"new":true}');
    expect(await readdir(dir)).toEqual(['progress-rahul.json']);
  });

  it('serializes concurrent writes to one file so the last call wins and nothing is torn', async () => {
    const file = path.join(dir, 'x.json');
    await Promise.all(Array.from({ length: 20 }, (_, i) => writeFileAtomic(file, JSON.stringify({ i, pad: 'x'.repeat(5000) }))));
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { i: number };
    expect(parsed.i).toBe(19);
    expect(await readdir(dir)).toEqual(['x.json']);
  });
});

describe('readJsonFile', () => {
  it('returns undefined for a missing file and throws with the path for invalid JSON', async () => {
    expect(await readJsonFile(path.join(dir, 'missing.json'))).toBeUndefined();
    await writeFile(path.join(dir, 'bad.json'), '{oops');
    await expect(readJsonFile(path.join(dir, 'bad.json'))).rejects.toThrow(/bad\.json/);
  });
});

describe('KeyedMutex', () => {
  it('runs tasks for one key one at a time, other keys in parallel', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    const task = (key: string, label: string, ms: number) =>
      mutex.run(key, async () => {
        order.push(`start ${label}`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`end ${label}`);
      });
    await Promise.all([task('a', 'a1', 20), task('a', 'a2', 1), task('b', 'b1', 1)]);
    expect(order.indexOf('end a1')).toBeLessThan(order.indexOf('start a2'));
    expect(order.indexOf('start b1')).toBeLessThan(order.indexOf('end a1'));
  });
});

describe('progress last-writer-wins', () => {
  it('pickNewer keeps whichever has the larger updatedAt (ties keep the stored copy)', () => {
    const stored = progress(100);
    expect(pickNewer(null, progress(1))).toEqual({ winner: progress(1), changed: true });
    expect(pickNewer(stored, progress(200)).changed).toBe(true);
    expect(pickNewer(stored, progress(50))).toEqual({ winner: stored, changed: false });
    expect(pickNewer(stored, progress(100, { lastLectureId: null }))).toEqual({ winner: stored, changed: false });
  });

  it('validateProgress names the first bad field', () => {
    expect(validateProgress(progress(1))).toBeNull();
    expect(validateProgress({ ...progress(1), v: 2 })).toMatch(/v/);
    expect(validateProgress({ ...progress(1), updatedAt: 'now' })).toMatch(/updatedAt/);
    expect(validateProgress({ ...progress(1), lectures: { a: { pos: -1, done: false, doneAt: null } } })).toMatch(/lectures/);
    expect(validateProgress({ ...progress(1), days: { '2026-10-01': 'x' } })).toMatch(/days/);
    expect(validateProgress({ ...progress(1), prefs: { rate: 1 } })).toMatch(/prefs/);
    expect(validateProgress([])).not.toBeNull();
  });

  it('ProgressStore stores per profile and answers with the winner', async () => {
    const { log } = memoryLog();
    const store = new ProgressStore(dir, log);
    expect(await store.get('rahul')).toBeNull();
    expect(await store.put('rahul', progress(200))).toEqual(progress(200));
    expect(await store.put('rahul', progress(100, { days: {} }))).toEqual(progress(200));
    expect(await store.put('rahul', progress(300, { days: {} }))).toEqual(progress(300, { days: {} }));
    expect(await store.get('rahul')).toEqual(progress(300, { days: {} }));
    expect(await store.get('mansi')).toBeNull();
    expect((await readdir(dir)).sort()).toEqual(['progress-rahul.json']);
  });

  it('moves a corrupt SSD copy aside (logged) instead of blocking the profile forever', async () => {
    const { log, lines } = memoryLog();
    await writeFile(path.join(dir, 'progress-rahul.json'), '{"v":1, trunc');
    const store = new ProgressStore(dir, log);
    expect(await store.get('rahul')).toBeNull();
    expect(lines.some((l) => l.startsWith('[store] progress-rahul.json is unreadable'))).toBe(true);
    expect((await readdir(dir)).sort()).toEqual(['progress-rahul.json.corrupt']);
    expect(await store.put('rahul', progress(5))).toEqual(progress(5));
  });
});

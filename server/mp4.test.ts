import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readFileDuration, readMp4Duration, resolveDurations, type ByteReader } from './mp4.ts';
import { box, makeTempDir, memoryLog, mp4 } from './test-helpers.ts';

function bufferReader(buf: Buffer): { read: ByteReader; reads: Array<[number, number]> } {
  const reads: Array<[number, number]> = [];
  return {
    reads,
    read: async (offset, length) => {
      reads.push([offset, length]);
      return buf.subarray(offset, offset + length);
    },
  };
}

describe('readMp4Duration (mvhd inside moov)', () => {
  it('reads a v0 mvhd', async () => {
    const file = mp4({ version: 0, timescale: 1000, duration: 61_500 });
    expect(await readMp4Duration(bufferReader(file).read, file.length)).toBeCloseTo(61.5);
  });

  it('reads a v1 mvhd (64-bit times and duration)', async () => {
    const file = mp4({ version: 1, timescale: 90_000, duration: 90_000 * 3600 * 2 });
    expect(await readMp4Duration(bufferReader(file).read, file.length)).toBeCloseTo(7200);
  });

  it('finds moov at the end, skipping mdat by its header without reading it', async () => {
    const file = mp4({ moovAtEnd: true, mdatBytes: 100_000, duration: 5_000 });
    const { read, reads } = bufferReader(file);
    expect(await readMp4Duration(read, file.length)).toBeCloseTo(5);
    // no read may cover the media payload (that is what makes 405 cold files fast)
    expect(reads.every(([, len]) => len <= 1024)).toBe(true);
  });

  it('handles a 64-bit (largesize) mdat before moov', async () => {
    const file = mp4({ moovAtEnd: true, mdat64: true, duration: 42_000 });
    expect(await readMp4Duration(bufferReader(file).read, file.length)).toBeCloseTo(42);
  });

  it('returns null without moov/mvhd, for a zero timescale, or for a truncated file', async () => {
    const noMoov = Buffer.concat([box('ftyp', Buffer.alloc(8)), box('mdat', Buffer.alloc(64))]);
    expect(await readMp4Duration(bufferReader(noMoov).read, noMoov.length)).toBeNull();
    const zeroScale = mp4({ timescale: 0 });
    expect(await readMp4Duration(bufferReader(zeroScale).read, zeroScale.length)).toBeNull();
    const truncated = mp4({ moovAtEnd: true }).subarray(0, 40);
    expect(await readMp4Duration(bufferReader(truncated).read, 10_000)).toBeNull();
  });
});

describe('readFileDuration + resolveDurations (cache keyed by relpath, size, mtime)', () => {
  let dir = '';
  let cleanup: () => Promise<void> = async () => {};
  beforeEach(async () => {
    ({ dir, cleanup } = await makeTempDir('mp4'));
  });
  afterEach(() => cleanup());

  it('reads a real file', async () => {
    await writeFile(path.join(dir, 'a.mp4'), mp4({ duration: 12_000 }));
    expect(await readFileDuration(path.join(dir, 'a.mp4'))).toBeCloseTo(12);
  });

  it('uses the cache when size + mtime match and re-reads when they change', async () => {
    await writeFile(path.join(dir, 'a.mp4'), mp4({ duration: 10_000 }));
    await writeFile(path.join(dir, 'b.mp4'), mp4({ duration: 20_000 }));
    const files = async () =>
      Promise.all(
        ['a.mp4', 'b.mp4'].map(async (relPath) => {
          const s = await stat(path.join(dir, relPath));
          return { relPath, size: s.size, mtimeMs: s.mtimeMs };
        }),
      );
    const { log } = memoryLog();

    const first = await resolveDurations(dir, await files(), {}, { log });
    expect(first.misses).toBe(2);
    expect(first.durations.get('b.mp4')).toBeCloseTo(20);

    // a stale entry for a file that no longer exists is pruned
    const second = await resolveDurations(dir, await files(), { ...first.cache, 'gone.mp4': { size: 1, mtimeMs: 1, duration: 1 } }, { log });
    expect(second.misses).toBe(0);
    expect(second.changed).toBe(true);
    expect(Object.keys(second.cache).sort()).toEqual(['a.mp4', 'b.mp4']);

    await utimes(path.join(dir, 'a.mp4'), new Date(), new Date(Date.now() + 5000));
    const third = await resolveDurations(dir, await files(), second.cache, { log });
    expect(third.misses).toBe(1);
    expect(third.durations.get('a.mp4')).toBeCloseTo(10);
  });

  it('logs and returns 0 for an unreadable video instead of failing the scan', async () => {
    await writeFile(path.join(dir, 'broken.mp4'), Buffer.from('not an mp4 at all'));
    const s = await stat(path.join(dir, 'broken.mp4'));
    const { log, lines } = memoryLog();
    const res = await resolveDurations(dir, [{ relPath: 'broken.mp4', size: s.size, mtimeMs: s.mtimeMs }], {}, { log });
    expect(res.durations.get('broken.mp4')).toBe(0);
    expect(res.cache['broken.mp4']).toBeUndefined();
    expect(lines.some((l) => l.startsWith('[scan] no duration for broken.mp4'))).toBe(true);
  });
});

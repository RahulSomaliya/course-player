import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConfigStore } from './config.ts';
import { makeTempDir } from './test-helpers.ts';

let dir = '';
let cleanup: () => Promise<void> = async () => {};
beforeEach(async () => {
  ({ dir, cleanup } = await makeTempDir('config'));
});
afterEach(() => cleanup());

const seed = {
  title: 'The Ultimate React Course',
  subtitle: 'Jonas Schmedtmann · 2023',
  profiles: [
    { id: 'rahul', name: 'Rahul' },
    { id: 'mansi', name: 'Mansi' },
  ],
};

describe('ConfigStore', () => {
  it('falls back to no title and no profiles when config.json is absent', async () => {
    const config = await ConfigStore.load(dir);
    expect(config.title).toBeNull();
    expect(config.subtitle).toBeNull();
    expect(config.profiles()).toEqual([]);
    expect(config.exists).toBe(false);
  });

  it('reads the seeded config and exposes profiles without any journey link', async () => {
    await writeFile(path.join(dir, 'config.json'), JSON.stringify(seed));
    const config = await ConfigStore.load(dir);
    expect(config.title).toBe('The Ultimate React Course');
    expect(config.subtitle).toBe('Jonas Schmedtmann · 2023');
    expect(config.profiles()).toEqual([
      { id: 'rahul', name: 'Rahul', journeyConnected: false },
      { id: 'mansi', name: 'Mansi', journeyConnected: false },
    ]);
  });

  it('saves and forgets a journey link atomically, keeping unknown fields', async () => {
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({ ...seed, futureField: 42 }));
    const config = await ConfigStore.load(dir);
    expect(await config.setJourneyLink('mansi', 'https://jj.example/m/tok_123')).toEqual({
      id: 'mansi',
      name: 'Mansi',
      journeyConnected: true,
    });
    const onDisk = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8')) as typeof seed & { futureField: number };
    expect(onDisk.futureField).toBe(42);
    expect(onDisk.profiles[1]).toEqual({ id: 'mansi', name: 'Mansi', journeyLink: 'https://jj.example/m/tok_123' });
    expect(JSON.stringify(config.profiles())).not.toContain('tok_123');

    const reloaded = await ConfigStore.load(dir);
    expect(reloaded.journeyLink('mansi')).toBe('https://jj.example/m/tok_123');
    await reloaded.setJourneyLink('mansi', null);
    expect((await ConfigStore.load(dir)).journeyLink('mansi')).toBeNull();
  });

  it('keeps both links when two profiles connect at the same time (no lost read-modify-write)', async () => {
    await writeFile(path.join(dir, 'config.json'), JSON.stringify(seed));
    const config = await ConfigStore.load(dir);
    await Promise.all([
      config.setJourneyLink('rahul', 'https://jj.example/m/tok_r'),
      config.setJourneyLink('mansi', 'https://jj.example/m/tok_m'),
    ]);
    const reloaded = await ConfigStore.load(dir);
    expect([reloaded.journeyLink('rahul'), reloaded.journeyLink('mansi')]).toEqual([
      'https://jj.example/m/tok_r',
      'https://jj.example/m/tok_m',
    ]);
  });

  it('fails loudly (with the path) on invalid JSON or an invalid shape', async () => {
    await writeFile(path.join(dir, 'config.json'), '{nope');
    await expect(ConfigStore.load(dir)).rejects.toThrow(/config\.json/);
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({ profiles: [{ id: 'Bad Id!', name: 'x' }] }));
    await expect(ConfigStore.load(dir)).rejects.toThrow(/profiles\[0\]\.id/);
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({ profiles: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }] }));
    await expect(ConfigStore.load(dir)).rejects.toThrow(/duplicate/);
  });
});

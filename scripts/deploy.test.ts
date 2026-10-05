// scripts/deploy.sh against a fake dist + a temp course folder (COURSE_PLAYER_DIST): what it writes,
// and above all what it never touches (.player/data — her link, progress and outbox).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { makeTempDir, writeTree } from '../server/test-helpers.ts';

const run = promisify(execFile);
const SCRIPT = path.resolve('scripts/deploy.sh');

let tmp = '';
let dist = '';
let root = '';
let cleanup: () => Promise<void> = async () => {};

beforeEach(async () => {
  ({ dir: tmp, cleanup } = await makeTempDir('deploy'));
  dist = path.join(tmp, 'dist');
  root = path.join(tmp, 'React Course');
  await writeTree(dist, { 'bin/course-player-arm64': 'arm', 'bin/course-player-x64': 'x64', 'web/index.html': '<!doctype html>' });
  await mkdir(root, { recursive: true });
});
afterEach(() => cleanup());

async function deploy(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return run('bash', [SCRIPT, ...args], { env: { ...process.env, COURSE_PLAYER_DIST: dist } });
}

const pinned = async (): Promise<unknown> => JSON.parse(await readFile(path.join(root, '.player', 'course.json'), 'utf8')) as unknown;

describe('npm run deploy', () => {
  it('pins the course id in .player/course.json (React default: react-2023), whatever the folder is called', async () => {
    const { stdout } = await deploy(root);
    expect(await pinned()).toEqual({ id: 'react-2023' });
    expect(stdout).toContain('course id react-2023');
    expect((await readdir(path.join(root, '.player'))).sort()).toEqual(['bin', 'course.json', 'data', 'web']);
    expect(await readdir(root)).toContain('🟢 Open React Course.command');
  });

  it('--course-id overrides it (either position); a non-React label must name its id', async () => {
    await deploy('--course-id', 'js-course', root, 'JavaScript');
    expect(await pinned()).toEqual({ id: 'js-course' });
    await deploy(root, '--course-id=react-2023');
    expect(await pinned()).toEqual({ id: 'react-2023' });
    await expect(deploy(root, 'Vue')).rejects.toMatchObject({ stderr: expect.stringContaining('--course-id') as unknown });
    await expect(deploy(root, '--course-id', 'React 2023')).rejects.toMatchObject({ stderr: expect.stringContaining('course id') as unknown });
  });

  it('warns when the pinned id changes (browser data is keyed by it) and never touches .player/data', async () => {
    await writeTree(root, {
      '.player/course.json': JSON.stringify({ id: 'react-course' }),
      '.player/data/config.json': '{"profiles":[{"id":"mansi","name":"Mansi","journeyLink":"https://jj.example/m/tok"}]}',
      '.player/data/outbox-mansi.json': '{"v":2,"items":[],"lastError":null}',
    });
    const { stdout } = await deploy(root);
    expect(stdout).toContain('course id changed: react-course -> react-2023');
    expect(await pinned()).toEqual({ id: 'react-2023' });
    expect(await readFile(path.join(root, '.player/data/config.json'), 'utf8')).toContain('tok');
    expect(await readFile(path.join(root, '.player/data/outbox-mansi.json'), 'utf8')).toBe('{"v":2,"items":[],"lastError":null}');
  });

  it('seeds config.json only when absent', async () => {
    await deploy(root);
    const seeded = await readFile(path.join(root, '.player/data/config.json'), 'utf8');
    expect(seeded).toContain('"mansi"');
    await writeFile(path.join(root, '.player/data/config.json'), '{"profiles":[]}');
    await deploy(root);
    expect(await readFile(path.join(root, '.player/data/config.json'), 'utf8')).toBe('{"profiles":[]}');
  });
});

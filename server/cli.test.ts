import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { parseArgs } from './cli.ts';

const dev = { isSea: false, execPath: '/usr/local/bin/node', cwd: '/repo' };
const sea = { isSea: true, execPath: '/Volumes/SSD/Course/.player/bin/course-player-arm64', cwd: '/Volumes/SSD/Course' };

describe('parseArgs', () => {
  it('--version needs nothing else', () => {
    expect(parseArgs(['--version'], dev)).toEqual({ kind: 'version' });
  });

  it('applies the defaults (dev: dist/web under the cwd)', () => {
    expect(parseArgs(['--root', 'Course'], dev)).toEqual({
      kind: 'run',
      options: {
        root: '/repo/Course',
        port: 8795,
        open: false,
        dataDir: '/repo/Course/.player/data',
        webDir: '/repo/dist/web',
      },
    });
  });

  it('as a single executable the web dir is <dirname(execPath)>/../web', () => {
    const res = parseArgs(['--root', '/Volumes/SSD/Course', '--open'], sea);
    expect(res).toMatchObject({ kind: 'run', options: { webDir: '/Volumes/SSD/Course/.player/web', open: true } });
  });

  it('accepts --flag value and --flag=value forms, with paths containing spaces and apostrophes', () => {
    const root = "/Volumes/Rahul's SSD/Courses/Coding FE/React 2023";
    const res = parseArgs([`--root=${root}`, '--port=8799', '--data', '/tmp/cp data', '--web', 'web dist'], dev);
    expect(res).toEqual({
      kind: 'run',
      options: { root, port: 8799, open: false, dataDir: '/tmp/cp data', webDir: path.join('/repo', 'web dist') },
    });
  });

  it('reports usage errors', () => {
    expect(parseArgs([], dev)).toMatchObject({ kind: 'error', message: expect.stringMatching(/--root/) });
    expect(parseArgs(['--root', ''], dev)).toMatchObject({ kind: 'error' });
    expect(parseArgs(['--root'], dev)).toMatchObject({ kind: 'error' });
    expect(parseArgs(['--root', 'x', '--port', 'abc'], dev)).toMatchObject({ kind: 'error', message: expect.stringMatching(/port/) });
    expect(parseArgs(['--root', 'x', '--port', '70000'], dev)).toMatchObject({ kind: 'error' });
    expect(parseArgs(['--root', 'x', '--nope'], dev)).toMatchObject({ kind: 'error', message: expect.stringMatching(/--nope/) });
    expect(parseArgs(['--help'], dev)).toEqual({ kind: 'help' });
  });
});

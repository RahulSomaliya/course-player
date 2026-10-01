import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openMediaStreams, parseRange, resolveUnderRoot, serveMedia } from './media.ts';
import { makeTempDir, memoryLog, request, writeTree } from './test-helpers.ts';

describe('parseRange', () => {
  it('handles bytes=a-b, a- and -n', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ kind: 'range', start: 0, end: 99 });
    expect(parseRange('bytes=500-', 1000)).toEqual({ kind: 'range', start: 500, end: 999 });
    expect(parseRange('bytes=-100', 1000)).toEqual({ kind: 'range', start: 900, end: 999 });
  });

  it('clamps an end past EOF and a suffix longer than the file', () => {
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ kind: 'range', start: 900, end: 999 });
    expect(parseRange('bytes=-5000', 1000)).toEqual({ kind: 'range', start: 0, end: 999 });
  });

  it('is unsatisfiable when the start is at/after EOF, for -0, or for an empty file', () => {
    expect(parseRange('bytes=1000-', 1000)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=1000-1200', 1000)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=-0', 1000)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
  });

  it('ignores missing, malformed, inverted and multi-range headers (-> full 200)', () => {
    expect(parseRange(undefined, 1000)).toEqual({ kind: 'none' });
    expect(parseRange('items=0-5', 1000)).toEqual({ kind: 'none' });
    expect(parseRange('bytes=-', 1000)).toEqual({ kind: 'none' });
    expect(parseRange('bytes=50-10', 1000)).toEqual({ kind: 'none' });
    expect(parseRange('bytes=0-1,5-6', 1000)).toEqual({ kind: 'none' });
  });
});

describe('media over a real server', () => {
  let tmp = '';
  let root = '';
  let cleanup: () => Promise<void> = async () => {};
  let server: http.Server;
  let port = 0;
  const big = Buffer.alloc(8 * 1024 * 1024, 7);
  const { log, lines } = memoryLog();

  beforeAll(async () => {
    ({ dir: tmp, cleanup } = await makeTempDir('media'));
    root = path.join(tmp, 'Course');
    const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
    await writeTree(root, {
      '01 Welcome/01 Intro.mp4': bytes,
      '01 Welcome/02 Big.mp4': big,
      '01 Welcome/03 Read Me.html': '<p>hello</p>',
      '01 Welcome/04 Slides #1.pdf': '%PDF-1.4',
      '01 Welcome/notes.txt': 'not a course file type',
      '01 Welcome/._01 Intro.mp4': 'sidecar',
      '.player/data/progress-rahul.json': '{}',
    });
    await writeFile(path.join(tmp, 'secret.mp4'), 'outside the root');
    await symlink(path.join(tmp, 'secret.mp4'), path.join(root, '01 Welcome', '09 Escape.mp4'));
    server = http.createServer((req, res) => {
      const raw = (req.url ?? '').split('?')[0] ?? '';
      void serveMedia(req, res, root, raw.slice('/media/'.length), log);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await cleanup();
  });

  const intro = '/media/01%20Welcome/01%20Intro.mp4';

  it('serves the whole file with 200 when there is no Range', async () => {
    const res = await request(port, 'GET', intro);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-length']).toBe('1000');
    expect(res.body.length).toBe(1000);
  });

  it('answers ranges with 206 + Content-Range and the exact bytes', async () => {
    const res = await request(port, 'GET', intro, { headers: { range: 'bytes=10-19' } });
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 10-19/1000');
    expect([...res.body]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    const tail = await request(port, 'GET', intro, { headers: { range: 'bytes=-4' } });
    expect(tail.headers['content-range']).toBe('bytes 996-999/1000');
    expect(tail.body.length).toBe(4);
    const open = await request(port, 'GET', intro, { headers: { range: 'bytes=990-' } });
    expect(open.headers['content-length']).toBe('10');
  });

  it('answers 416 with the size for an unsatisfiable range', async () => {
    const res = await request(port, 'GET', intro, { headers: { range: 'bytes=5000-' } });
    expect(res.status).toBe(416);
    expect(res.headers['content-range']).toBe('bytes */1000');
  });

  it('serves html and pdf with their types (html sandboxed into its own origin)', async () => {
    const html = await request(port, 'GET', '/media/01%20Welcome/03%20Read%20Me.html');
    expect(html.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(html.headers['content-security-policy']).toMatch(/^sandbox/);
    const pdf = await request(port, 'GET', '/media/01%20Welcome/04%20Slides%20%231.pdf');
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
  });

  it('HEAD sends headers only', async () => {
    const res = await request(port, 'HEAD', intro);
    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe('1000');
    expect(res.body.length).toBe(0);
  });

  it.each([
    ['parent segment', '/media/../secret.mp4'],
    ['encoded parent segment', '/media/%2e%2e/secret.mp4'],
    ['encoded slash inside a segment', '/media/01%20Welcome%2F..%2F..%2Fsecret.mp4'],
    ['dot folder', '/media/.player/data/progress-rahul.json'],
    ['AppleDouble sidecar', '/media/01%20Welcome/._01%20Intro.mp4'],
    ['symlink escaping the root', '/media/01%20Welcome/09%20Escape.mp4'],
    ['unknown file type', '/media/01%20Welcome/notes.txt'],
    ['missing file', '/media/01%20Welcome/99%20Nope.mp4'],
    ['a directory', '/media/01%20Welcome'],
    ['malformed escape', '/media/01%20Welcome/%E0%A4%A.mp4'],
    ['empty segment', '/media/01%20Welcome//01%20Intro.mp4'],
  ])('404s a %s', async (_label, url) => {
    const res = await request(port, 'GET', url);
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('outside the root');
  });

  it('logs 404s with the decoded path', () => {
    expect(lines).toContain('[media] 404 01 Welcome/99 Nope.mp4');
  });

  it('destroys the read stream when the client aborts mid-file (no leaked fds)', async () => {
    await new Promise<void>((resolve, reject) => {
      const req = http.get(
        { host: '127.0.0.1', port, path: '/media/01%20Welcome/02%20Big.mp4', headers: { host: `localhost:${port}` }, agent: false },
        (res) => {
          res.once('data', () => {
            expect(openMediaStreams()).toBe(1);
            req.destroy();
            resolve();
          });
        },
      );
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'ECONNRESET') reject(err);
      });
    });
    await vi.waitFor(() => expect(openMediaStreams()).toBe(0), { timeout: 2000 });
  });

  it('resolveUnderRoot returns the absolute file for a valid path', async () => {
    expect(await resolveUnderRoot(root, '01%20Welcome/01%20Intro.mp4')).toBe(path.join(root, '01 Welcome', '01 Intro.mp4'));
  });
});

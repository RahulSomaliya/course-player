// GET /media/<path>: stream a course file with HTTP Range support (docs/spec.md §2 "Media").
// The guard below is the only thing between the browser and the rest of the disk: every segment is
// decoded on its own and rejected if it is empty, starts with "." (covers "..", .player/ and `._*`),
// or smuggles a separator; then the realpath must still be inside the realpath of --root (symlinks).
// Callers must pass the RAW request path: WHATWG `new URL()` already collapses "/../" and "%2e%2e",
// which would hide a traversal attempt from this guard instead of rejecting it.
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { errorMessage, type Log } from './log.ts';
import { sendText } from './http.ts';

export type RangeResult = { kind: 'none' } | { kind: 'range'; start: number; end: number } | { kind: 'unsatisfiable' };

const RANGE_RE = /^bytes=(\d*)-(\d*)$/;

/** Single byte ranges only; anything malformed or multi-range is ignored (full 200), as RFC 9110 allows. */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (header === undefined) return { kind: 'none' };
  const m = RANGE_RE.exec(header.trim());
  if (!m) return { kind: 'none' };
  const [, a = '', b = ''] = m;
  if (a === '' && b === '') return { kind: 'none' };
  if (a === '') {
    const n = Number(b);
    if (n === 0 || size === 0) return { kind: 'unsatisfiable' };
    return { kind: 'range', start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  if (b !== '' && Number(b) < start) return { kind: 'none' };
  if (start >= size) return { kind: 'unsatisfiable' };
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  return { kind: 'range', start, end };
}

const MEDIA_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.html': 'text/html; charset=utf-8',
};

/** Decodes "a%20b/c.mp4" segment by segment; null for anything the guard rejects. */
function decodeSegments(encoded: string): string[] | null {
  const segments: string[] = [];
  for (const raw of encoded.split('/')) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null; // malformed %-escape -> not a path we could have produced
    }
    if (seg === '' || seg.startsWith('.') || /[/\\\0]/.test(seg)) return null;
    segments.push(seg);
  }
  return segments;
}

/** Absolute path of a regular file inside `root`, or null (-> 404). */
export async function resolveUnderRoot(root: string, encoded: string): Promise<string | null> {
  const segments = decodeSegments(encoded);
  if (!segments || segments.length === 0) return null;
  const abs = path.join(root, ...segments);
  let real: string;
  let realRoot: string;
  try {
    [real, realRoot] = await Promise.all([realpath(abs), realpath(root)]);
    if (!(await stat(real)).isFile()) return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
    throw err;
  }
  const rel = path.relative(realRoot, real);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return abs;
}

let activeStreams = 0;

/** Open media read streams (tests assert this returns to 0 after a client abort). */
export function openMediaStreams(): number {
  return activeStreams;
}

function displayPath(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

export async function serveMedia(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  encodedRelPath: string,
  log: Log,
): Promise<void> {
  const file = await resolveUnderRoot(root, encodedRelPath);
  const type = file === null ? undefined : MEDIA_TYPES[path.extname(file).toLowerCase()];
  if (file === null || type === undefined) {
    log(`[media] 404 ${displayPath(encodedRelPath)}`);
    sendText(res, 404, 'Not found');
    return;
  }

  const { size } = await stat(file);
  const range = parseRange(req.headers.range, size);
  const headers: Record<string, string | number> = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'x-content-type-options': 'nosniff',
  };
  // Course html opened in its own tab must not run in the app's origin (it could read every
  // profile's localStorage). The web app fetches article html and sanitizes it, unaffected by this.
  if (type.startsWith('text/html')) headers['content-security-policy'] = 'sandbox allow-popups allow-popups-to-escape-sandbox';

  if (range.kind === 'unsatisfiable') {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${size}`, 'content-length': 0 });
    res.end();
    return;
  }
  const start = range.kind === 'range' ? range.start : 0;
  const end = range.kind === 'range' ? range.end : size - 1;
  if (range.kind === 'range') headers['content-range'] = `bytes ${start}-${end}/${size}`;
  headers['content-length'] = size === 0 ? 0 : end - start + 1;
  res.writeHead(range.kind === 'range' ? 206 : 200, headers);
  if (req.method === 'HEAD' || size === 0) {
    res.end();
    return;
  }

  const stream = createReadStream(file, { start, end });
  activeStreams++;
  stream.once('close', () => activeStreams--);
  try {
    // pipeline destroys the read stream (and closes its fd) when the response closes early.
    await pipeline(stream, res);
  } catch (err) {
    // Seeking aborts in-flight requests constantly; a premature close is the normal case.
    if ((err as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE') return;
    log(`[media] read failed ${displayPath(encodedRelPath)}: ${errorMessage(err)}`);
    res.destroy();
  }
}

// mp4 duration = mvhd.duration / mvhd.timescale, read from the top-level `moov` box by seeking box
// headers. Never read `mdat`: a cold read of 405 videos off the SSD must stay at a few KB per file.
// Results are cached in <data>/durations.json keyed by relpath and invalidated by size + mtime.
import { open } from 'node:fs/promises';
import path from 'node:path';
import type { Log } from './log.ts';

/** Returns up to `length` bytes at `offset` (fewer at end of file). */
export type ByteReader = (offset: number, length: number) => Promise<Buffer>;

interface BoxRange {
  start: number; // first payload byte
  end: number; // one past the last byte
}

async function findBox(read: ByteReader, from: number, to: number, type: string): Promise<BoxRange | null> {
  let offset = from;
  while (offset + 8 <= to) {
    const head = await read(offset, 16);
    if (head.length < 8) return null;
    const size32 = head.readUInt32BE(0);
    const boxType = head.toString('latin1', 4, 8);
    let headerLen = 8;
    let size: number;
    if (size32 === 1) {
      // 64-bit "largesize" follows the type (used for > 4 GiB mdat boxes)
      if (head.length < 16) return null;
      size = Number(head.readBigUInt64BE(8));
      headerLen = 16;
    } else if (size32 === 0) {
      size = to - offset; // box runs to the end of its parent / the file
    } else {
      size = size32;
    }
    if (size < headerLen) return null; // corrupt header; stop instead of looping forever
    if (boxType === type) return { start: offset + headerLen, end: Math.min(offset + size, to) };
    offset += size;
  }
  return null;
}

/** Duration in seconds, or null when the file has no readable moov/mvhd. */
export async function readMp4Duration(read: ByteReader, fileSize: number): Promise<number | null> {
  const moov = await findBox(read, 0, fileSize, 'moov');
  if (!moov) return null;
  const mvhd = await findBox(read, moov.start, moov.end, 'mvhd');
  if (!mvhd) return null;
  const body = await read(mvhd.start, 32);
  if (body.length < 1) return null;
  let timescale: number;
  let duration: number;
  if (body.readUInt8(0) === 1) {
    // v1: version+flags(4) creation(8) modification(8) timescale(4) duration(8)
    if (body.length < 32) return null;
    timescale = body.readUInt32BE(20);
    const big = body.readBigUInt64BE(24);
    if (big === 0xffff_ffff_ffff_ffffn) return null; // "unknown"
    duration = Number(big);
  } else {
    // v0: version+flags(4) creation(4) modification(4) timescale(4) duration(4)
    if (body.length < 20) return null;
    timescale = body.readUInt32BE(12);
    duration = body.readUInt32BE(16);
    if (duration === 0xffff_ffff) return null; // "unknown"
  }
  if (timescale === 0) return null;
  return duration / timescale;
}

export async function readFileDuration(file: string): Promise<number | null> {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    return await readMp4Duration(async (offset, length) => {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      return buf.subarray(0, bytesRead);
    }, size);
  } finally {
    await fh.close();
  }
}

// ---- cache --------------------------------------------------------------------------------

export interface DurationEntry {
  size: number;
  mtimeMs: number;
  duration: number;
}

export type DurationCache = Record<string, DurationEntry>;

export interface VideoFile {
  relPath: string;
  size: number;
  mtimeMs: number;
}

export interface ResolvedDurations {
  durations: Map<string, number>;
  /** files whose duration had to be read (cache miss) */
  misses: number;
  /** the new cache: only files that still exist, only successful reads */
  cache: DurationCache;
  /** true when `cache` differs from the input and should be written back */
  changed: boolean;
}

export function isDurationCache(value: unknown): value is DurationCache {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (e: unknown) =>
      typeof e === 'object' &&
      e !== null &&
      typeof (e as DurationEntry).size === 'number' &&
      typeof (e as DurationEntry).mtimeMs === 'number' &&
      typeof (e as DurationEntry).duration === 'number',
  );
}

export async function resolveDurations(
  root: string,
  videos: VideoFile[],
  cache: DurationCache,
  opts: { log: Log; concurrency?: number },
): Promise<ResolvedDurations> {
  const { log, concurrency = 8 } = opts;
  const durations = new Map<string, number>();
  const next: DurationCache = {};
  const todo: VideoFile[] = [];
  for (const v of videos) {
    const hit = cache[v.relPath];
    if (hit && hit.size === v.size && hit.mtimeMs === v.mtimeMs) {
      durations.set(v.relPath, hit.duration);
      next[v.relPath] = hit;
    } else {
      todo.push(v);
    }
  }

  let done = 0;
  const step = Math.max(1, Math.ceil(todo.length / 10));
  if (todo.length > 0) log(`[scan] reading ${todo.length} video durations…`);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < todo.length) {
      const v = todo[cursor++] as VideoFile;
      let duration: number | null = null;
      let reason = 'no moov/mvhd box';
      try {
        duration = await readFileDuration(path.join(root, v.relPath));
      } catch (err) {
        reason = err instanceof Error ? err.message : String(err);
      }
      if (duration === null) {
        // Not cached, so it is retried on the next start; the lecture still plays, it just shows 0:00.
        log(`[scan] no duration for ${v.relPath}: ${reason}`);
        durations.set(v.relPath, 0);
      } else {
        durations.set(v.relPath, duration);
        next[v.relPath] = { size: v.size, mtimeMs: v.mtimeMs, duration };
      }
      done++;
      if (done % step === 0 && done < todo.length) log(`[scan] durations ${done}/${todo.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));

  const changed = todo.length > 0 || Object.keys(cache).length !== Object.keys(next).length;
  return { durations, misses: todo.length, cache: next, changed };
}

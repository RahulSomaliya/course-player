// Course scan: folder tree under --root -> Course (docs/spec.md §2 "Scanning" + "Durations").
// Every name starting with "." is ignored: that covers .player/ and the `._*` AppleDouble sidecars
// exFAT grows next to every file — never "fix" that filter to a narrower one.
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Course, Lecture, Resource, Section } from '../shared/types.ts';
import { errorMessage, type Log } from './log.ts';
import { isDurationCache, resolveDurations, type DurationCache, type VideoFile } from './mp4.ts';
import { mediaHref, parseFileName, parseRedirectUrl, parseSectionName, type FileExt } from './names.ts';
import { JsonFileError, readJsonFile, writeFileAtomic } from './store.ts';

export interface ScanOptions {
  root: string;
  /** holds durations.json */
  dataDir: string;
  /** Course.id, resolved by course-id.ts — never derived from the folder name here (2026-10-05 incident) */
  courseId: string;
  /** from config.json; null -> the folder name */
  title: string | null;
  subtitle: string | null;
  log: Log;
  concurrency?: number;
}

export interface ScanResult {
  course: Course;
  /** videos whose duration was read from disk instead of durations.json */
  misses: number;
}

interface PendingResource {
  lecture: number;
  sub: number;
  resource: Resource;
  relPath: string;
}

const REDIRECT_PEEK_BYTES = 64 * 1024;

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

async function readHead(file: string, bytes: number): Promise<string> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function toResource(root: string, relPath: string, title: string, ext: FileExt): Promise<Resource> {
  if (ext === 'pdf') return { title, kind: 'pdf', href: mediaHref(relPath) };
  if (ext === 'html') {
    const url = parseRedirectUrl(await readHead(path.join(root, relPath), REDIRECT_PEEK_BYTES));
    if (url !== null) return { title, kind: 'link', href: url };
  }
  return { title, kind: 'link', href: mediaHref(relPath) };
}

/** A resource belongs to lecture NN; when that lecture is missing it goes to the nearest earlier
 *  lecture, else the first one — resources are never dropped while the section has a lecture. */
function lectureFor(lectures: Lecture[], number: number): Lecture | undefined {
  const exact = lectures.find((l) => l.number === number);
  if (exact) return exact;
  const earlier = lectures.filter((l) => l.number < number);
  return earlier[earlier.length - 1] ?? lectures[0];
}

async function loadDurationCache(file: string, log: Log): Promise<DurationCache> {
  let raw: unknown;
  try {
    raw = await readJsonFile(file);
  } catch (err) {
    if (!(err instanceof JsonFileError)) throw err;
    log(`[scan] ${path.basename(file)} is not valid JSON — re-reading every duration`);
    return {};
  }
  if (raw === undefined) return {};
  if (!isDurationCache(raw)) {
    log(`[scan] ${path.basename(file)} has an unexpected shape — re-reading every duration`);
    return {};
  }
  return raw;
}

export async function scanCourse(opts: ScanOptions): Promise<ScanResult> {
  const { root, dataDir, log } = opts;
  const sectionDirs = (await readdir(root, { withFileTypes: true }))
    .filter((e) => !e.name.startsWith('.') && e.isDirectory())
    .map((e) => e.name)
    .sort(byName);

  const seen = new Set<string>();
  const chosen: Array<{ dir: string; parsed: NonNullable<ReturnType<typeof parseSectionName>> }> = [];
  for (const dir of sectionDirs) {
    const parsed = parseSectionName(dir);
    if (!parsed) continue;
    if (seen.has(parsed.id)) {
      log(`[scan] skipped "${dir}": section ${parsed.id} already exists`);
      continue;
    }
    seen.add(parsed.id);
    chosen.push({ dir, parsed });
  }

  const videos: VideoFile[] = [];
  const built = await Promise.all(
    chosen.map(async ({ dir, parsed }) => {
      const names = (await readdir(path.join(root, dir))).filter((n) => !n.startsWith('.')).sort(byName);
      const lectures: Lecture[] = [];
      const pending: PendingResource[] = [];
      for (const name of names) {
        const file = parseFileName(name);
        if (!file) continue;
        const relPath = `${dir}/${name}`;
        const st = await stat(path.join(root, relPath));
        if (!st.isFile()) continue;
        if (file.role === 'resource') {
          const resource = await toResource(root, relPath, file.title, file.ext);
          pending.push({ lecture: file.lecture, sub: file.sub, resource, relPath });
          continue;
        }
        if (file.kind === 'video') videos.push({ relPath, size: st.size, mtimeMs: st.mtimeMs });
        lectures.push({
          id: relPath,
          number: file.number,
          title: file.title,
          kind: file.kind,
          duration: 0, // filled in once durations are resolved
          src: mediaHref(relPath),
          resources: [],
        });
      }
      lectures.sort((a, b) => a.number - b.number || byName(a.id, b.id));
      pending.sort((a, b) => a.lecture - b.lecture || a.sub - b.sub);
      for (const r of pending) {
        const target = lectureFor(lectures, r.lecture);
        if (target) target.resources.push(r.resource);
        else log(`[scan] dropped resource "${r.relPath}": its section has no lectures`);
      }
      return { dir, parsed, lectures };
    }),
  );

  const cacheFile = path.join(dataDir, 'durations.json');
  const resolved = await resolveDurations(root, videos, await loadDurationCache(cacheFile, log), {
    log,
    concurrency: opts.concurrency ?? 8,
  });
  if (resolved.changed) {
    try {
      await writeFileAtomic(cacheFile, JSON.stringify(resolved.cache));
    } catch (err) {
      // The scan result is still correct; only the next start is slower.
      log(`[scan] could not write ${cacheFile}: ${errorMessage(err)}`);
    }
  }

  const sections: Section[] = [];
  for (const { dir, parsed, lectures } of built) {
    if (lectures.length === 0) {
      log(`[scan] skipped "${dir}": no lectures`);
      continue;
    }
    for (const l of lectures) if (l.kind === 'video') l.duration = resolved.durations.get(l.id) ?? 0;
    sections.push({
      id: parsed.id,
      number: parsed.number,
      title: parsed.title,
      optional: parsed.optional,
      part: parsed.part,
      lectures,
      duration: lectures.reduce((sum, l) => sum + l.duration, 0),
    });
  }

  const all = sections.flatMap((s) => s.lectures);
  const totals = {
    lectures: all.length,
    videos: all.filter((l) => l.kind === 'video').length,
    duration: sections.reduce((sum, s) => sum + s.duration, 0),
  };
  log(
    `[scan] ${sections.length} sections, ${totals.lectures} lectures, ${totals.videos} videos, ` +
      `${(totals.duration / 3600).toFixed(1)} h (${resolved.misses} cache misses)`,
  );

  return {
    course: {
      id: opts.courseId,
      title: opts.title ?? path.basename(path.resolve(root)),
      subtitle: opts.subtitle,
      sections,
      totals,
    },
    misses: resolved.misses,
  };
}

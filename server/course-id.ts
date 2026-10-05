// Course.id — the course JS Journey files her updates under, and the namespace of every browser storage
// key. Resolved ONCE at start-up, first match wins (shared/types.ts CourseIdSource):
//   1. <course>/.player/course.json `{ "id": "react-2023" }` — written by `npm run deploy` (--course-id).
//      It sits OUTSIDE .player/data on purpose: "update Mansi's copy" = copy bin, web, course.json and
//      the launcher, never her data (README).
//   2. config.json `courseId` (optional; hand-edited fix for a copy without course.json).
//   3. slug of the course folder name — a GUESS, logged loudly. v1/v2 used only this: her copy lived in
//      a folder not named "React 2023", so its id was not "react-2023", JS Journey 404'd "unknown course"
//      and the outbox dropped her sign-off for good (2026-10-05). Never make the folder the default again.
// An unreadable or invalid course.json fails the start-up (like an invalid config.json): falling back to
// the folder would bring the silent wrong id straight back.
import path from 'node:path';
import type { CourseIdSource } from '../shared/types.ts';
import type { ConfigStore } from './config.ts';
import type { Log } from './log.ts';
import { slugify } from './names.ts';
import { readJsonFile } from './store.ts';

/** "react-2023", "js-course": lowercase words joined by single dashes (JS Journey's ids; also safe in a
 *  storage key and a query string). Shared with config.ts and mirrored in scripts/deploy.sh. */
export const COURSE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COURSE_ID_MAX = 64;

export const isCourseId = (x: unknown): x is string => typeof x === 'string' && x.length <= COURSE_ID_MAX && COURSE_ID_RE.test(x);

export function courseFile(root: string): string {
  return path.join(root, '.player', 'course.json');
}

/** The v1/v2 id: slug of the course folder name (BootPayload.folderCourseId — browser data from before v3
 *  sits under it). */
export function folderCourseId(root: string): string {
  return slugify(path.basename(path.resolve(root)));
}

export interface ResolvedCourseId {
  id: string;
  from: CourseIdSource;
}

export async function resolveCourseId(opts: { root: string; config: ConfigStore; log: Log }): Promise<ResolvedCourseId> {
  const file = courseFile(opts.root);
  const pinned = await readJsonFile(file); // throws (naming the file) on invalid JSON
  if (pinned !== undefined) {
    const id = typeof pinned === 'object' && pinned !== null && !Array.isArray(pinned) ? (pinned as { id?: unknown }).id : undefined;
    if (!isCourseId(id)) throw new Error(`${file}: id must be a course id like "react-2023" (lowercase words joined by "-")`);
    return { id, from: 'course.json' };
  }
  if (opts.config.courseId !== null) return { id: opts.config.courseId, from: 'config.json' };
  const id = folderCourseId(opts.root);
  opts.log(
    `[scan] WARNING: course id "${id}" was guessed from the folder name — JS Journey only knows its own ids, ` +
      `so updates may not reach Rahul. Pin it: npm run deploy (writes ${file}) or { "id": "react-2023" } in that file.`,
  );
  return { id, from: 'folder' };
}

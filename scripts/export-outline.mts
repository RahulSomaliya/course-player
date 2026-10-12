// Regenerates the course outline JSON that JS Journey commits (lib/outline/react-2023.json there): its coach
// page's week → section → lecture view reads titles, numbers, kinds and lengths from it, plus the latest
// snapshot's doneLectures (docs/spec-v4-pace-and-coach.md "Coach page"). Run it when the course's files
// change, then copy the output into JS Journey and commit it there.
//
//   npx tsx scripts/export-outline.mts "<course root>" [--out <file.json>] [--course-id <id>] [--cache <dir>]
//
//   npx tsx scripts/export-outline.mts "/Volumes/Rahul's SSD/Courses/Coding FE/React 2023" \
//     --out ~/Developer/js-journey/lib/outline/react-2023.json
//
// READ-ONLY on the course: the same scan the server runs at start-up (server/scan.ts — folder names + mp4
// headers), nothing else. Its durations cache goes to a fresh temp dir, deleted afterwards, unless --cache
// names a dir to keep between runs (reading 400 mp4 headers off the SSD is the slow part). NEVER the
// course's .player/data — Mansi's progress and outbox live there, and the SSD is exFAT (1 MiB a new file):
// an --out or --cache inside the course root is refused.
// Course id: --course-id, else the course's .player/course.json (written by `npm run deploy`); never the
// folder name (server/course-id.ts: a guessed id once lost her sign-offs).
// Output (stdout, or --out): ONE line of JSON + "\n" — the shape JS Journey's tests pin:
//   { course, sections: [{ number, title, optional, part, lectures: [{ number, title, kind, seconds }] }] }
// seconds = the lecture's video length rounded (0 for articles / pdfs). Scan notes go to stderr.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { Lecture, Section } from '../shared/types.ts';
import { courseFile, isCourseId } from '../server/course-id.ts';
import { scanCourse } from '../server/scan.ts';
import { readJsonFile } from '../server/store.ts';

interface OutlineLecture {
  number: number;
  title: string;
  kind: Lecture['kind'];
  seconds: number;
}
interface OutlineSection {
  number: number;
  title: string;
  optional: boolean;
  part: Section['part'];
  lectures: OutlineLecture[];
}
interface CourseOutline {
  course: string;
  sections: OutlineSection[];
}

const USAGE = 'usage: npx tsx scripts/export-outline.mts "<course root>" [--out <file.json>] [--course-id <id>] [--cache <dir>]';

function fail(message: string): never {
  process.stderr.write(`export-outline: ${message}\n${USAGE}\n`);
  process.exit(1);
}

/** true when `p` is the course root or anything under it */
function insideRoot(root: string, p: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function courseIdOf(root: string, given: string | undefined): Promise<string> {
  if (given !== undefined) {
    if (!isCourseId(given)) fail(`--course-id "${given}" is not a course id like "react-2023"`);
    return given;
  }
  const file = courseFile(root);
  const pinned = await readJsonFile(file); // read only; throws (naming the file) on invalid JSON
  const id = typeof pinned === 'object' && pinned !== null && !Array.isArray(pinned) ? (pinned as { id?: unknown }).id : undefined;
  if (!isCourseId(id)) fail(`no course id: pass --course-id, or deploy the course first (${file})`);
  return id;
}

function toOutline(courseId: string, sections: readonly Section[]): CourseOutline {
  return {
    course: courseId,
    sections: sections.map((s) => ({
      number: s.number,
      title: s.title,
      optional: s.optional,
      part: s.part,
      lectures: s.lectures.map((l) => ({ number: l.number, title: l.title, kind: l.kind, seconds: Math.round(l.duration) })),
    })),
  };
}

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { out: { type: 'string' }, 'course-id': { type: 'string' }, cache: { type: 'string' } },
});
const root = positionals[0];
if (root === undefined || positionals.length > 1) fail('give exactly one course root');
if (values.out !== undefined && insideRoot(root, values.out)) fail(`--out must be outside the course (${values.out}) — the scan never writes to it`);
if (values.cache !== undefined && insideRoot(root, values.cache)) fail(`--cache must be outside the course (${values.cache}) — never its .player/data`);

const courseId = await courseIdOf(root, values['course-id']);
const dataDir = values.cache ?? (await mkdtemp(path.join(os.tmpdir(), 'course-outline-')));
try {
  const { course } = await scanCourse({
    root,
    dataDir,
    courseId,
    title: null,
    subtitle: null,
    log: (line) => process.stderr.write(line + '\n'),
  });
  const json = JSON.stringify(toOutline(courseId, course.sections)) + '\n';
  if (values.out === undefined) process.stdout.write(json);
  else {
    await writeFile(values.out, json);
    process.stderr.write(`export-outline: wrote ${values.out} (${course.sections.length} sections, ${course.totals.lectures} lectures)\n`);
  }
} finally {
  if (values.cache === undefined) await rm(dataDir, { recursive: true, force: true });
}

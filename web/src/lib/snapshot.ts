// Progress snapshot (docs/spec-v2-coaching.md "Progress snapshot"): her numbers as the player computes
// them, sent with every update and PUT to the local server (which forwards it to JS Journey, latest
// wins). The coach view renders these same numbers, so this must agree with lib/stats.ts + the
// Continue pick (lib/course.ts nextLecture) — never compute "done" a second way here.
import type { Course, ProgressSnapshot, ProgressState } from '../../../shared/types';
import { isSectionDone, nextLecture, type CourseIndex } from './course';
import { addDays, localDateKey } from './dates';

/** days of study time the snapshot carries (the coach's 30-day chart + streak need far less) */
export const SNAPSHOT_DAYS = 120;
/** progress changes push at most this often; sign-off and Quit push at once */
export const SNAPSHOT_EVERY_MS = 5 * 60_000;
/** quiet delay before the first push of a burst of changes */
const QUIET_MS = 10_000;

export function buildSnapshot(course: Course, index: CourseIndex, state: ProgressState, now: number): ProgressSnapshot {
  let lecturesDone = 0;
  let videoSecondsDone = 0;
  const sectionsDone: number[] = [];
  const doneLectures: Record<string, number[]> = {};
  for (const s of course.sections) {
    const done = new Set<number>();
    for (const l of s.lectures) {
      if (!state.lectures[l.id]?.done) continue;
      lecturesDone++;
      videoSecondsDone += l.duration;
      // a "00 …" file parses as lecture 0: both validators refuse < 1 and would drop the WHOLE snapshot
      if (l.number >= 1) done.add(l.number);
    }
    if (isSectionDone(s, state.lectures)) sectionsDone.push(s.number);
    // v4 (the coach page's week → section → lecture view): ascending + unique — the local server and JS
    // Journey both refuse anything else (server/journey.ts validateProgressSnapshot); no empty lists.
    if (done.size > 0) doneLectures[String(s.number)] = [...done].sort((a, b) => a - b);
  }
  const nextId = nextLecture(index, state);
  const ref = nextId === null ? undefined : index.byId.get(nextId);
  const from = addDays(localDateKey(new Date(now)), -(SNAPSHOT_DAYS - 1));
  const days: Record<string, number> = {};
  for (const [key, seconds] of Object.entries(state.days)) {
    const whole = Math.round(seconds);
    if (key >= from && whole > 0) days[key] = whole;
  }
  return {
    course: course.id,
    takenAt: now,
    lecturesDone,
    lecturesTotal: course.totals.lectures,
    videoSecondsDone: Math.round(videoSecondsDone),
    videoSecondsTotal: Math.round(course.totals.duration),
    sectionsDone,
    current: ref ? { sectionNumber: ref.section.number, lectureNumber: ref.lecture.number, title: ref.lecture.title } : null,
    days,
    doneLectures,
  };
}

/** ms until the next debounced push: a short quiet delay, but never sooner than 5 min after the last one. */
export function nextPushDelay(lastPushAt: number | null, now: number): number {
  if (lastPushAt === null) return QUIET_MS;
  return Math.max(QUIET_MS, lastPushAt + SNAPSHOT_EVERY_MS - now);
}

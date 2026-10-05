// v2 → v3 (docs/spec-v3-study-timer.md A3 "Legacy v2 state"). v2 kept an activity session in
// `cp:<course>:<profile>:session`, earlier unsigned sittings in `…:pending` and (v1) `…:wrap`. v3 has a
// different session (lib/session.ts, key `…:study`), so on the first open of v3 each legacy session of
// ≥ 1 min is sent ONCE as recorded (its studied seconds, autoClosed: true, no note) and the keys are
// removed only after the course server took them (state/study.ts migrateLegacy). Nothing is dropped
// silently: < 1 min cannot be sent (JS Journey needs minutes > 0 without a note) and is logged.
// The keys are read under the pinned course id AND BootPayload.folderCourseId: v3 pinned the id
// (server/course-id.ts), and on her Mac the old keys sit under the folder slug ("react-course").
// Its study time is NOT credited again: the v2 ticker already wrote it to ProgressState.days.
import type { JourneySession, ProgressSnapshot } from '../../../shared/types';
import { localDateKey } from './dates';
import { MAX_UPDATE_MINUTES, mainSection, type CompletedLecture } from './session';
import { readString, type KeyValueStore } from './storage';

/** a legacy session shorter than this has nothing JS Journey would take (minutes rounds to 0) */
export const LEGACY_MIN_SECONDS = 60;
const SUFFIXES = ['session', 'pending', 'wrap'] as const;

/** v2's LiveSession, as it sits in localStorage */
export interface LegacySession {
  id: string;
  startedAt: number;
  lastStudyAt: number;
  /** studied seconds (v2 counted only player activity) */
  seconds: number;
  sectionSeconds: Record<string, number>;
  lecturesCompleted: CompletedLecture[];
  finishedSections: number[];
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

function isLegacySession(x: unknown): x is LegacySession {
  return (
    isRecord(x) &&
    typeof x.id === 'string' &&
    isNum(x.startedAt) &&
    isNum(x.lastStudyAt) &&
    isNum(x.seconds) &&
    isRecord(x.sectionSeconds) &&
    Object.values(x.sectionSeconds).every(isNum) &&
    Array.isArray(x.lecturesCompleted) &&
    x.lecturesCompleted.every((l) => isRecord(l) && isNum(l.section) && isNum(l.lecture) && typeof l.title === 'string') &&
    Array.isArray(x.finishedSections) &&
    x.finishedSections.every(isNum)
  );
}

/** :session = one session · :pending = a list · :wrap = { session } (v1) */
function sessionsIn(suffix: (typeof SUFFIXES)[number], value: unknown): LegacySession[] | null {
  if (suffix === 'session') return isLegacySession(value) ? [value] : null;
  if (suffix === 'pending') return Array.isArray(value) && value.every(isLegacySession) ? value : null;
  return isRecord(value) && isLegacySession(value.session) ? [value.session] : null;
}

export function legacyKeys(courseIds: readonly string[], profile: string): string[] {
  return courseIds.flatMap((id) => SUFFIXES.map((suffix) => `cp:${id}:${profile}:${suffix}`));
}

/** Every legacy session (each id once) and every legacy key present — an unreadable one included, so it
 *  is removed with the rest instead of being re-read (and re-warned about) on every open. */
export function readLegacy(storage: KeyValueStore | null, courseIds: readonly string[], profile: string): { sessions: LegacySession[]; keys: string[] } {
  const sessions: LegacySession[] = [];
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const id of new Set(courseIds)) {
    for (const suffix of SUFFIXES) {
      const key = `cp:${id}:${profile}:${suffix}`;
      const raw = readString(storage, key);
      if (raw === null) continue;
      keys.push(key);
      let found: LegacySession[] | null = null;
      try {
        found = sessionsIn(suffix, JSON.parse(raw) as unknown);
      } catch (err) {
        console.warn(`[study] ${key}: unreadable v2 study state — it cannot be sent and is removed`, err);
        continue;
      }
      if (found === null) {
        console.warn(`[study] ${key}: v2 study state of an unknown shape — it cannot be sent and is removed`);
        continue;
      }
      for (const s of found) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        sessions.push(s);
      }
    }
  }
  return { sessions, keys };
}

/** The update a legacy session becomes: as recorded, sent without her (autoClosed), no note. */
export function legacyUpdate(s: LegacySession, o: { courseId: string; progress: ProgressSnapshot | null; fallbackSection: number }): JourneySession {
  return {
    id: s.id,
    course: o.courseId,
    startedAt: new Date(s.startedAt).toISOString(),
    endedAt: new Date(Math.max(s.lastStudyAt, s.startedAt)).toISOString(),
    studyDate: localDateKey(new Date(s.startedAt)),
    minutes: Math.min(MAX_UPDATE_MINUTES, Math.round(s.seconds / 60)),
    sectionNumber: mainSection(s) || o.fallbackSection,
    lecturesCompleted: s.lecturesCompleted.map(({ section, lecture, title }) => ({ section, lecture, title })),
    finishedSections: [...s.finishedSections],
    mood: null,
    note: null,
    stuck: false,
    autoClosed: true,
    progress: o.progress,
  };
}

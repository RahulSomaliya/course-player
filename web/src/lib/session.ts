// Study sessions (spec "Study sessions"). Pure helpers; web/src/state/study.ts drives them.
// A session starts with the first studied second and ends on "End session", Quit, or 20 min without
// studying. Sessions under 5 min are never sent to JS Journey (they still count in local stats, which
// read ProgressState.days, not sessions).
import type { JourneySession } from '../../../shared/types';
import { localDateKey } from './dates';

export const SESSION_IDLE_MS = 20 * 60_000;
export const MIN_SEND_SECONDS = 5 * 60;
export const MOODS = ['😄', '🙂', '😐', '😩'] as const;
export type Mood = (typeof MOODS)[number];

export interface CompletedLecture {
  section: number;
  lecture: number;
  title: string;
}

export interface LiveSession {
  /** uuid v4 — JS Journey dedups on it, so retries are safe */
  id: string;
  startedAt: number; // epoch ms
  lastStudyAt: number; // epoch ms of the last studied second
  seconds: number; // studied seconds in this session
  /** section number → studied seconds */
  sectionSeconds: Record<string, number>;
  lecturesCompleted: CompletedLecture[];
  finishedSections: number[];
}

export function accumulate(s: LiveSession | null, now: number, seconds: number, sectionNumber: number, newId: () => string): LiveSession {
  const base: LiveSession = s ?? {
    id: newId(),
    startedAt: now - seconds * 1000,
    lastStudyAt: now,
    seconds: 0,
    sectionSeconds: {},
    lecturesCompleted: [],
    finishedSections: [],
  };
  const key = String(sectionNumber);
  return {
    ...base,
    lastStudyAt: now,
    seconds: base.seconds + seconds,
    sectionSeconds: { ...base.sectionSeconds, [key]: (base.sectionSeconds[key] ?? 0) + seconds },
  };
}

export function isIdle(s: LiveSession, now: number): boolean {
  return now - s.lastStudyAt > SESSION_IDLE_MS;
}

export function addCompleted(s: LiveSession, l: CompletedLecture): LiveSession {
  if (s.lecturesCompleted.some((x) => x.section === l.section && x.lecture === l.lecture)) return s;
  return { ...s, lecturesCompleted: [...s.lecturesCompleted, l] };
}

export function removeCompleted(s: LiveSession, section: number, lecture: number): LiveSession {
  const next = s.lecturesCompleted.filter((x) => !(x.section === section && x.lecture === lecture));
  return next.length === s.lecturesCompleted.length ? s : { ...s, lecturesCompleted: next };
}

export function addFinishedSection(s: LiveSession, section: number): LiveSession {
  return s.finishedSections.includes(section) ? s : { ...s, finishedSections: [...s.finishedSections, section] };
}

/** The section she spent the most study time in (ties → the lower number). */
export function mainSection(s: LiveSession): number {
  let best = 0;
  let bestSeconds = -1;
  for (const [k, secs] of Object.entries(s.sectionSeconds)) {
    const n = Number(k);
    if (secs > bestSeconds || (secs === bestSeconds && n < best)) {
      best = n;
      bestSeconds = secs;
    }
  }
  return best;
}

export function toJourneySession(
  s: LiveSession,
  opts: { courseId: string; endedAt: number; mood: Mood | null; note: string | null },
): JourneySession | null {
  if (s.seconds < MIN_SEND_SECONDS) return null;
  const note = opts.note?.trim() ?? '';
  return {
    id: s.id,
    course: opts.courseId,
    startedAt: new Date(s.startedAt).toISOString(),
    endedAt: new Date(Math.max(opts.endedAt, s.startedAt)).toISOString(),
    studyDate: localDateKey(new Date(s.startedAt)),
    minutes: Math.max(1, Math.round(s.seconds / 60)),
    sectionNumber: mainSection(s),
    lecturesCompleted: s.lecturesCompleted.map(({ section, lecture, title }) => ({ section, lecture, title })),
    finishedSections: [...s.finishedSections],
    mood: opts.mood,
    note: note === '' ? null : note.slice(0, 2000),
  };
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Validates a session read back from localStorage (a reload continues it). */
export function isLiveSession(x: unknown): x is LiveSession {
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

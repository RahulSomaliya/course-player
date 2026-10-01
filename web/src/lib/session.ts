// Study sessions = what she studied since her last sign-off (docs/spec-v2-coaching.md "Sign-off card").
// Pure helpers; web/src/state/study.ts drives them. A session starts with the first studied second and
// ends only when she signs off (or the 24 h rule sends it for her). Local stats read ProgressState.days,
// not sessions, so a session that is never sent still counts there.
import type { JourneySession, ProgressSnapshot } from '../../../shared/types';
import { localDateKey } from './dates';

export const SESSION_IDLE_MS = 20 * 60_000;
/** a session under 5 min is sent only with a note */
export const MIN_SEND_SECONDS = 5 * 60;
/** JS Journey refuses minutes > 1440 with a 400, and the outbox drops a 4xx'd update for good */
export const MAX_UPDATE_MINUTES = 1440;
/** an unsigned session older than this (since its last studied second) is sent with autoClosed: true */
export const PENDING_MAX_AGE_MS = 24 * 3_600_000;
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

/** 20 min without studying: the session stops growing and waits for her note (the header's dot).
 *  Nothing is sent by itself any more (v2) — see state/study.ts for what happens next. */
export function isWaiting(s: LiveSession, now: number): boolean {
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

/** What one sign-off card step is about: an earlier sitting, this one, or nothing (a note-only update). */
export type SignOffTarget = { kind: 'pending'; session: LiveSession } | { kind: 'live'; session: LiveSession } | { kind: 'note' };

export interface SignOffAnswer {
  mood: Mood | null;
  note: string | null;
  /** she ticked "I'm stuck" — the coach view flags the update */
  stuck: boolean;
}

export interface UpdateOptions {
  courseId: string;
  /** id for a note-only update (no session): a fresh uuid, so a retried POST dedups */
  noteId: string;
  now: number;
  answer: SignOffAnswer;
  /** true when the player sends it without her (the 24 h rule) */
  autoClosed: boolean;
  progress: ProgressSnapshot | null;
  /** her current section, for a note-only update — never 0: JS Journey 400s it (StudyController.deliver) */
  fallbackSection: number;
}

/**
 * One sign-off = one update for Rahul (docs/spec-v2-coaching.md "Sign-off card").
 * - A session under 5 min with no note is not sent (null); with a note it is.
 * - No session at all + a note = a note-only update (she studied away from the player): minutes 0.
 * - endedAt is the last studied second, not the moment she pressed Send (the note may come later).
 */
export function toUpdate(s: LiveSession | null, o: UpdateOptions): JourneySession | null {
  const note = o.answer.note?.trim() ?? '';
  const seconds = s?.seconds ?? 0;
  if (note === '' && seconds < MIN_SEND_SECONDS) return null;
  const startedAt = s?.startedAt ?? o.now;
  const endedAt = s === null ? o.now : Math.max(s.lastStudyAt, s.startedAt);
  return {
    id: s?.id ?? o.noteId,
    course: o.courseId,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    studyDate: localDateKey(new Date(startedAt)),
    // 0 only for a note-only update (shared/types.ts); a 20 s session with a note rounds to 0 too.
    minutes: Math.min(MAX_UPDATE_MINUTES, Math.round(seconds / 60)),
    sectionNumber: s !== null && seconds > 0 ? mainSection(s) : o.fallbackSection,
    lecturesCompleted: (s?.lecturesCompleted ?? []).map(({ section, lecture, title }) => ({ section, lecture, title })),
    finishedSections: [...(s?.finishedSections ?? [])],
    mood: o.answer.mood,
    note: note === '' ? null : note.slice(0, 2000),
    stuck: o.answer.stuck,
    autoClosed: o.autoClosed,
    progress: o.progress,
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

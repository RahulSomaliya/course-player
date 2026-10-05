// The study session (docs/spec-v3-study-timer.md A3): ONE wall-clock timer from "Start studying" (or the
// first lecture she plays / opens — auto-start) to the moment she presses Send. Elapsed = now − startedAt;
// nothing pauses it, nothing ends or sends it by itself. Pure helpers; web/src/state/study.ts drives them.
// v2's activity session (studied seconds, 20-min idle "waiting", `pending`, the 24 h auto-close) is gone:
// it under-counted everything she did outside the player, and its silent paths lost a sign-off
// (2026-10-05). The player still measures WHERE she studied (sectionSeconds → the update's section) — it
// never decides HOW LONG. Daily study time (ProgressState.days) is credited at sign-off from the minutes
// she SENDS (splitAcrossDays); while the timer runs the UI only adds it for display (liveDays).
import type { JourneySession, ProgressSnapshot } from '../../../shared/types';
import { localDateKey } from './dates';

/** JS Journey refuses minutes > 1440 with a 400 (lib/player.ts there) — the most one update can carry */
export const MAX_UPDATE_MINUTES = 1440;
/** JS Journey's note cap */
const NOTE_MAX = 2000;
export const MOODS = ['😄', '🙂', '😐', '😩'] as const;
export type Mood = (typeof MOODS)[number];

export interface CompletedLecture {
  section: number;
  lecture: number;
  title: string;
}

/** Persisted under `cp:<course>:<profile>:study` (state/study.ts) — NOT v2's `…:session` key/shape. */
export interface StudySession {
  /** uuid v4 = the update's id — JS Journey dedups on it, so a re-sent update is safe */
  id: string;
  /** epoch ms; the timer is now − startedAt */
  startedAt: number;
  /** a lecture started it (play / open), not the Start studying button */
  autoStarted: boolean;
  lecturesCompleted: CompletedLecture[];
  /** sections that became 100 % done during the session */
  finishedSections: number[];
  /** section number → seconds of player time in it: WHERE she studied, never how long */
  sectionSeconds: Record<string, number>;
}

export function newSession(id: string, now: number, autoStarted: boolean): StudySession {
  return { id, startedAt: now, autoStarted, lecturesCompleted: [], finishedSections: [], sectionSeconds: {} };
}

/** Whole seconds on the timer (a clock set backwards reads 0, never negative). */
export function timerSeconds(s: Pick<StudySession, 'startedAt'>, now: number): number {
  return Math.max(0, Math.floor((now - s.startedAt) / 1000));
}

/** Whole minutes on the timer, rounded DOWN (the sign-off card's prefill and its max). */
export function timerMinutes(s: Pick<StudySession, 'startedAt'>, now: number): number {
  return Math.floor(timerSeconds(s, now) / 60);
}

/** The most she can send for this session: the timer, capped at JS Journey's 24 h. */
export function sendableMinutes(s: Pick<StudySession, 'startedAt'>, now: number): number {
  return Math.min(MAX_UPDATE_MINUTES, timerMinutes(s, now));
}

export function addSectionTime(s: StudySession, sectionNumber: number, seconds: number): StudySession {
  if (seconds <= 0) return s;
  const key = String(sectionNumber);
  return { ...s, sectionSeconds: { ...s.sectionSeconds, [key]: (s.sectionSeconds[key] ?? 0) + seconds } };
}

export function addCompleted(s: StudySession, l: CompletedLecture): StudySession {
  if (s.lecturesCompleted.some((x) => x.section === l.section && x.lecture === l.lecture)) return s;
  return { ...s, lecturesCompleted: [...s.lecturesCompleted, l] };
}

export function removeCompleted(s: StudySession, section: number, lecture: number): StudySession {
  const next = s.lecturesCompleted.filter((x) => !(x.section === section && x.lecture === lecture));
  return next.length === s.lecturesCompleted.length ? s : { ...s, lecturesCompleted: next };
}

export function addFinishedSection(s: StudySession, section: number): StudySession {
  return s.finishedSections.includes(section) ? s : { ...s, finishedSections: [...s.finishedSections, section] };
}

/** The section she spent the most player time in (ties → the lower number); 0 = no player time. */
export function mainSection(s: Pick<StudySession, 'sectionSeconds'>): number {
  let best = 0;
  let bestSeconds = 0;
  for (const [k, secs] of Object.entries(s.sectionSeconds)) {
    const n = Number(k);
    if (secs > bestSeconds || (secs === bestSeconds && secs > 0 && n < best)) {
      best = n;
      bestSeconds = secs;
    }
  }
  return best;
}

/** = JS Journey canSignOff (lib/player.ts): an update needs minutes > 0 or a note. */
export function canSend(minutes: number, note: string | null): boolean {
  return minutes > 0 || (note ?? '').trim() !== '';
}

/**
 * `seconds` credited to the local calendar days [startedAt, endedAt] spans, in proportion to the
 * wall-clock time in each day (spec A3). Largest-remainder rounding: the parts sum to exactly `seconds`.
 * Day boundaries come from the local Date constructor, so a DST day is 23 or 25 hours, as she lived it.
 */
export function splitAcrossDays(startedAt: number, endedAt: number, seconds: number): Record<string, number> {
  const total = Math.max(0, Math.round(seconds));
  if (total === 0) return {};
  const end = Math.max(startedAt, endedAt);
  const span = end - startedAt;
  if (span === 0) return { [localDateKey(new Date(startedAt))]: total };
  const parts: { key: string; whole: number; rest: number }[] = [];
  let given = 0;
  for (let from = startedAt; from < end; ) {
    const d = new Date(from);
    const to = Math.min(end, new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime());
    const exact = (total * (to - from)) / span;
    const whole = Math.floor(exact);
    given += whole;
    parts.push({ key: localDateKey(d), whole, rest: exact - whole });
    from = to;
  }
  let left = total - given;
  for (const p of [...parts].sort((a, b) => b.rest - a.rest)) {
    if (left <= 0) break;
    p.whole++;
    left--;
  }
  const out: Record<string, number> = {};
  for (const p of parts) if (p.whole > 0) out[p.key] = (out[p.key] ?? 0) + p.whole;
  return out;
}

/** `days` plus the running timer (≤ 24 h, like what she can send), split over the days it spans. DISPLAY
 *  ONLY (Today, streak, 30-day chart): it reaches ProgressState.days only at sign-off, from what she sends. */
export function liveDays(days: Record<string, number>, s: StudySession, now: number): Record<string, number> {
  const add = splitAcrossDays(s.startedAt, now, Math.min(timerSeconds(s, now), MAX_UPDATE_MINUTES * 60));
  const out = { ...days };
  for (const [key, secs] of Object.entries(add)) out[key] = (out[key] ?? 0) + secs;
  return out;
}

export interface SignOffAnswer {
  /** what she sends: the timer, or less (edited); ignored for a note-only update */
  minutes: number;
  mood: Mood | null;
  note: string | null;
  /** she ticked "I'm stuck" — the coach view flags the update */
  stuck: boolean;
}

export interface UpdateOptions {
  courseId: string;
  /** id for a note-only update (no session): a fresh uuid, so a retried POST dedups */
  noteId: string;
  /** the moment she pressed Send = the session's end */
  now: number;
  answer: SignOffAnswer;
  progress: ProgressSnapshot | null;
  /** her current section — used when the session has no player time; never 0 (JS Journey 400s it) */
  fallbackSection: number;
}

/** Her note as JS Journey stores it: trimmed, ≤ 2000 chars, null when empty. */
export function cleanNote(note: string | null): string | null {
  const t = note?.trim() ?? '';
  return t === '' ? null : t.slice(0, NOTE_MAX);
}

/**
 * One sign-off = one update for Rahul. A session → its id, startedAt → now (Send), her minutes (whole,
 * 0–1440); null = nothing to send (0 min and no note). No session = a note-only update (minutes 0).
 */
export function toUpdate(s: StudySession | null, o: UpdateOptions): JourneySession | null {
  const note = cleanNote(o.answer.note);
  const minutes = s === null ? 0 : Math.max(0, Math.min(MAX_UPDATE_MINUTES, Math.floor(o.answer.minutes)));
  if (!canSend(minutes, note)) return null;
  const startedAt = s?.startedAt ?? o.now;
  return {
    id: s?.id ?? o.noteId,
    course: o.courseId,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(Math.max(o.now, startedAt)).toISOString(),
    studyDate: localDateKey(new Date(startedAt)),
    minutes,
    sectionNumber: (s === null ? 0 : mainSection(s)) || o.fallbackSection,
    lecturesCompleted: (s?.lecturesCompleted ?? []).map(({ section, lecture, title }) => ({ section, lecture, title })),
    finishedSections: [...(s?.finishedSections ?? [])],
    mood: o.answer.mood,
    note,
    stuck: o.answer.stuck,
    autoClosed: false,
    progress: o.progress,
  };
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Validates a session read back from localStorage (a reload, a new tab, an app restart continue it). */
export function isStudySession(x: unknown): x is StudySession {
  return (
    isRecord(x) &&
    typeof x.id === 'string' &&
    isNum(x.startedAt) &&
    typeof x.autoStarted === 'boolean' &&
    isRecord(x.sectionSeconds) &&
    Object.values(x.sectionSeconds).every(isNum) &&
    Array.isArray(x.lecturesCompleted) &&
    x.lecturesCompleted.every((l) => isRecord(l) && isNum(l.section) && isNum(l.lecture) && typeof l.title === 'string') &&
    Array.isArray(x.finishedSections) &&
    x.finishedSections.every(isNum)
  );
}

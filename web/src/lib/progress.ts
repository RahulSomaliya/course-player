// ProgressState helpers: defaults, validation, LWW merge and immutable mutations.
// Every mutation stamps `updatedAt` — that stamp IS the merge rule between localStorage (primary)
// and the SSD copy (server/store.ts pickNewer mirrors this; keep the tie rule in sync: a tie keeps
// the copy you already hold).
import type { LectureProgress, Prefs, ProgressState } from '../../../shared/types';

export const DEFAULT_PREFS: Prefs = { rate: 1, volume: 1, muted: false, autoplay: true, theme: null };

export function emptyProgress(now = 0): ProgressState {
  return { v: 1, updatedAt: now, lectures: {}, days: {}, lastLectureId: null, prefs: { ...DEFAULT_PREFS } };
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isCount = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;

function isLectureProgress(x: unknown): x is LectureProgress {
  return isRecord(x) && isCount(x.pos) && typeof x.done === 'boolean' && (x.doneAt === null || isCount(x.doneAt));
}

function isPrefs(x: unknown): x is Prefs {
  return (
    isRecord(x) &&
    isCount(x.rate) &&
    isCount(x.volume) &&
    typeof x.muted === 'boolean' &&
    typeof x.autoplay === 'boolean' &&
    (x.theme === null || x.theme === 'light' || x.theme === 'dark')
  );
}

/** Same shape rules as server/store.ts validateProgress — a state that fails here would get a 400 there. */
export function isProgressState(x: unknown): x is ProgressState {
  return (
    isRecord(x) &&
    x.v === 1 &&
    isCount(x.updatedAt) &&
    isRecord(x.lectures) &&
    Object.values(x.lectures).every(isLectureProgress) &&
    isRecord(x.days) &&
    Object.values(x.days).every(isCount) &&
    (x.lastLectureId === null || typeof x.lastLectureId === 'string') &&
    isPrefs(x.prefs)
  );
}

/** Last writer wins on updatedAt; a tie keeps `local`. */
export function pickNewer(local: ProgressState | null, remote: ProgressState | null): ProgressState | null {
  if (local === null) return remote;
  if (remote === null) return local;
  return remote.updatedAt > local.updatedAt ? remote : local;
}

const blank: LectureProgress = { pos: 0, done: false, doneAt: null };

function withLecture(s: ProgressState, id: string, next: LectureProgress, now: number): ProgressState {
  const prev = s.lectures[id];
  if (prev && prev.pos === next.pos && prev.done === next.done && prev.doneAt === next.doneAt) return s;
  if (!prev && next.pos === 0 && !next.done) return s;
  return { ...s, updatedAt: now, lectures: { ...s.lectures, [id]: next } };
}

/** Position rounded to 0.1 s: keeps the pagehide keepalive body (64 KB cap) small. */
export function withPos(s: ProgressState, id: string, pos: number, now: number): ProgressState {
  const prev = s.lectures[id] ?? blank;
  return withLecture(s, id, { ...prev, pos: Math.max(0, Math.round(pos * 10) / 10) }, now);
}

export function withDone(s: ProgressState, id: string, done: boolean, now: number): ProgressState {
  const prev = s.lectures[id] ?? blank;
  const doneAt = done ? (prev.done ? prev.doneAt : now) : null;
  return withLecture(s, id, { ...prev, done, doneAt }, now);
}

export function withStudy(s: ProgressState, dayKey: string, seconds: number, now: number): ProgressState {
  if (seconds <= 0) return s;
  return { ...s, updatedAt: now, days: { ...s.days, [dayKey]: (s.days[dayKey] ?? 0) + seconds } };
}

export function withLast(s: ProgressState, id: string, now: number): ProgressState {
  return s.lastLectureId === id ? s : { ...s, updatedAt: now, lastLectureId: id };
}

export function withPrefs(s: ProgressState, patch: Partial<Prefs>, now: number): ProgressState {
  const next = { ...s.prefs, ...patch };
  const same = (Object.keys(next) as (keyof Prefs)[]).every((k) => next[k] === s.prefs[k]);
  return same ? s : { ...s, updatedAt: now, prefs: next };
}

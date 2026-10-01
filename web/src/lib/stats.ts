// Home stats: Today, Streak, Complete, Left (+ finish estimate) and the 30-day series.
import type { Course, LectureProgress } from '../../../shared/types';
import { addDays, daysBetween, localDateKey } from './dates';

type Days = Record<string, number>;
type Lectures = Record<string, LectureProgress>;

/** A day counts towards the streak at 5 min of study. */
export const STREAK_MIN_SECONDS = 300;
/** The finish estimate uses the content pace of at most the last 14 days. */
export const PACE_WINDOW_DAYS = 14;

export function studiedOn(days: Days, key: string): number {
  return days[key] ?? 0;
}

/** Consecutive days with ≥ 5 min, ending today — or yesterday, so the streak survives until today's study. */
export function streak(days: Days, today: string): number {
  let day = studiedOn(days, today) >= STREAK_MIN_SECONDS ? today : addDays(today, -1);
  let count = 0;
  while (studiedOn(days, day) >= STREAK_MIN_SECONDS) {
    count++;
    day = addDays(day, -1);
  }
  return count;
}

export interface Completion {
  /** % of the course's video duration marked done */
  percent: number;
  /** lectures of every kind marked done */
  doneLectures: number;
  totalLectures: number;
}

export function completion(course: Course, lectures: Lectures): Completion {
  let doneSeconds = 0;
  let doneLectures = 0;
  for (const s of course.sections) {
    for (const l of s.lectures) {
      if (!lectures[l.id]?.done) continue;
      doneLectures++;
      doneSeconds += l.duration;
    }
  }
  const total = course.totals.duration;
  return { percent: total > 0 ? (doneSeconds / total) * 100 : 0, doneLectures, totalLectures: course.totals.lectures };
}

/**
 * Remaining video time and a finish estimate at the recent content pace: video seconds marked done in
 * the window ÷ the window's days. The window is the last 14 days, shortened to the days since the
 * learner's first study day — otherwise someone who started 2 days ago would be measured over 14 days
 * and get an estimate months too late.
 */
export function timeLeft(course: Course, lectures: Lectures, days: Days, today: string): { remaining: number; eta: string | null } {
  let remaining = 0;
  let recent = 0;
  const firstStudied = Object.keys(days)
    .filter((k) => (days[k] ?? 0) > 0)
    .sort()[0];
  const span = firstStudied === undefined ? PACE_WINDOW_DAYS : daysBetween(firstStudied, today) + 1;
  const windowDays = Math.min(PACE_WINDOW_DAYS, Math.max(1, span));
  const windowStart = addDays(today, -(windowDays - 1));
  for (const s of course.sections) {
    for (const l of s.lectures) {
      const p = lectures[l.id];
      if (!p?.done) {
        remaining += l.duration;
        continue;
      }
      if (p.doneAt !== null) {
        const key = localDateKey(new Date(p.doneAt));
        if (key >= windowStart && key <= today) recent += l.duration;
      }
    }
  }
  remaining = Math.round(remaining);
  if (remaining === 0 || recent === 0) return { remaining, eta: null };
  const perDay = recent / windowDays;
  return { remaining, eta: addDays(today, Math.ceil(remaining / perDay)) };
}

export function last30(days: Days, today: string): { days: { key: string; seconds: number }[]; average: number } {
  const out: { key: string; seconds: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const key = addDays(today, -i);
    out.push({ key, seconds: studiedOn(days, key) });
  }
  const average = out.reduce((sum, d) => sum + d.seconds, 0) / out.length;
  return { days: out, average };
}

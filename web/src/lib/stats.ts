// Home stats: Today, Streak, Complete and the 30-day series. (The 4th stat, Due, comes from her plan:
// lib/week.ts dueStat.)
// MIRRORED in ~/Developer/js-journey lib/stats.ts (the coach view renders her numbers from the progress
// snapshot): change the streak rule, the 30-day average (studyAverage), the daily goal (goalMet) or the
// "<1%"/floor label in BOTH apps, or Rahul reads a different number than she does. All walk the plan
// calendar JourneyStatus carries (studyWeekdays + planBreaks).
import type { Course, JourneyStatus, LectureProgress } from '../../../shared/types';
import { addDays, isoWeekday } from './dates';

type Days = Record<string, number>;
type Lectures = Record<string, LectureProgress>;

/** A day counts towards the streak at 5 min of study. */
export const STREAK_MIN_SECONDS = 300;

export function studiedOn(days: Days, key: string): number {
  return days[key] ?? 0;
}

/** The plan calendar the streak walks: which weekdays are study days, and the breaks that are not. */
export interface StudyCalendar {
  /** ISO 1 = Mon … 7 = Sun */
  studyWeekdays: readonly number[];
  /** inclusive "YYYY-MM-DD" ranges */
  breaks: readonly { start: string; end: string }[];
}

/** Mon–Fri, no breaks: the calendar without a status (not connected, nothing cached), and what a status
 *  cached before these fields existed is filled with (state/journey.ts) — the same default the server
 *  fills for a JS Journey that predates them (server/journey.ts DEFAULT_STUDY_WEEKDAYS). */
export const DEFAULT_CALENDAR: StudyCalendar = { studyWeekdays: [1, 2, 3, 4, 5], breaks: [] };

/** Her plan's calendar from JourneyStatus. */
export function studyCalendar(status: JourneyStatus | null): StudyCalendar {
  return status ? { studyWeekdays: status.studyWeekdays, breaks: status.planBreaks } : DEFAULT_CALENDAR;
}

function isStudyDay(key: string, cal: StudyCalendar): boolean {
  return cal.studyWeekdays.includes(isoWeekday(key)) && !cal.breaks.some((b) => b.start <= key && key <= b.end);
}

/** Study days in a row, walking back from today: a day with ≥ 5 min adds 1 (a weekend or break day too);
 *  a plan study day under 5 min ends it — except today, still in progress; a weekend / break day under
 *  5 min is skipped. A calendar-day streak reset every Monday and all of Diwali (2026-10-01).
 *  `cal` is required on purpose: a call without it would read a quiet weekend as a missed day. */
export function streak(days: Days, today: string, cal: StudyCalendar): number {
  // nothing before the oldest real study day can add, so the walk ends there (and always ends —
  // a plan with no study days never breaks it)
  const oldest = Object.keys(days)
    .filter((k) => studiedOn(days, k) >= STREAK_MIN_SECONDS)
    .reduce<string | null>((a, k) => (a === null || k < a ? k : a), null);
  let count = 0;
  for (let day = today; oldest !== null && day >= oldest; day = addDays(day, -1)) {
    if (studiedOn(days, day) >= STREAK_MIN_SECONDS) count++;
    else if (day !== today && isStudyDay(day, cal)) break;
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

/** The 30-day chart's bars: 30 days ending today, oldest first, zeros filled. Its "avg" line is
 *  studyAverage — never the mean of these 30 (v4: her 2 h a day in week 1 read "avg 24m"). */
export function last30(days: Days, today: string): { key: string; seconds: number }[] {
  const out: { key: string; seconds: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const key = addDays(today, -i);
    out.push({ key, seconds: studiedOn(days, key) });
  }
  return out;
}

/** The chart's "avg" (spec v4 "Chart + daily goal"): every second studied from the start through today ÷ the
 *  plan STUDY days in that range. Weekend / break study adds to the total, never to the divisor; a missed
 *  study day counts as a day; today counts as a day only once it has ≥ 5 min (its seconds always add).
 *  `start` = JourneyStatus.startDate; null (no status, an older JS Journey) → her first day with ≥ 5 min.
 *  Before the start, or nothing studied → 0. Never ÷ 0: only weekend study so far → the total over one day. */
export function studyAverage(days: Days, today: string, cal: StudyCalendar, start: string | null): number {
  const from =
    start ??
    Object.keys(days)
      .filter((k) => studiedOn(days, k) >= STREAK_MIN_SECONDS)
      .reduce<string | null>((a, k) => (a === null || k < a ? k : a), null);
  if (from === null || today < from) return 0;
  let total = 0;
  for (const [key, seconds] of Object.entries(days)) if (key >= from && key <= today) total += seconds;
  let studyDays = 0;
  for (let day = from; day <= today; day = addDays(day, 1)) {
    if (!isStudyDay(day, cal)) continue;
    if (day === today && studiedOn(days, day) < STREAK_MIN_SECONDS) continue;
    studyDays++;
  }
  return total / Math.max(1, studyDays);
}

/** A day at or over the plan's daily study minutes (JourneyStatus.dailyGoalMinutes; React: 150). No goal
 *  known (an older JS Journey, not connected) → never met, and home shows no goal visuals at all. */
export function goalMet(seconds: number, dailyGoalMinutes: number | undefined): boolean {
  return dailyGoalMinutes !== undefined && dailyGoalMinutes > 0 && seconds >= dailyGoalMinutes * 60;
}

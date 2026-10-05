// The sign-off card's words (docs/spec-v3-study-timer.md A5): the timer line at the top ("Timer: 1h 23m ·
// started 9:14"), the Time studied fields she may lower (never above the timer, never above JS Journey's
// 24 h), what the session recorded, and the confirmation line after Send. Pure; SignOffCard renders it.
import type { Course, JourneySession } from '../../../shared/types';
import { localDateKey } from './dates';
import { formatDay, formatDuration, formatElapsed, formatTimeOfDay } from './format';
import { sectionShortName } from './outline';
import { MAX_UPDATE_MINUTES, mainSection, timerSeconds, type StudySession } from './session';

/** lecture titles listed before "+N more" */
const MAX_TITLES = 5;

export interface SessionSummary {
  /** "1h 23m" — the wall-clock timer */
  timer: string;
  /** "9:14", or "Mon 5 Oct, 9:14" when it started on another day */
  started: string;
  /** "§07 Thinking In React - State Management"; null = no player time */
  section: string | null;
  lectures: { shown: string[]; more: number };
  /** the timer ran over 24 h (a forgotten timer): the card asks for the real time */
  overDay: boolean;
}

export function describeSession(s: StudySession, course: Course, now: number): SessionSummary {
  const seconds = timerSeconds(s, now);
  const sameDay = localDateKey(new Date(s.startedAt)) === localDateKey(new Date(now));
  const section = course.sections.find((x) => x.number === mainSection(s));
  const titles = s.lecturesCompleted.map((l) => l.title);
  return {
    timer: formatElapsed(seconds),
    started: sameDay ? formatTimeOfDay(s.startedAt) : `${formatDay(localDateKey(new Date(s.startedAt)))}, ${formatTimeOfDay(s.startedAt)}`,
    section: section ? sectionShortName(section) : null,
    lectures: { shown: titles.slice(0, MAX_TITLES), more: Math.max(0, titles.length - MAX_TITLES) },
    overDay: seconds > MAX_UPDATE_MINUTES * 60,
  };
}

/** The two fields as minutes; '' counts as 0; null = not a whole number (the field is text + numeric
 *  keypad, so "1.5" or "e" can be typed and must be refused, not silently read as something). */
export function parseTime(hours: string, minutes: string): number | null {
  const h = hours.trim();
  const m = minutes.trim();
  if (!/^\d*$/.test(h) || !/^\d*$/.test(m)) return null;
  return Number(h || '0') * 60 + Number(m || '0');
}

/** Inline validation for Time studied; null = fine. `max` = the timer's whole minutes (uncapped: over a
 *  day says so instead of "more than the timer"). 0 is fine here — with a note it is a valid update. */
export function timeProblem(total: number | null, max: number): string | null {
  if (total === null) return 'Use whole hours and minutes.';
  if (total > MAX_UPDATE_MINUTES) return 'At most 24h in one update.';
  if (total > max) return `That’s more than the timer (${formatDuration(max * 60)}).`;
  return null;
}

/** Under "Sent to Rahul ✓": "1h 23m logged · note included". */
export function sentDetail(u: Pick<JourneySession, 'minutes' | 'note' | 'stuck'>): string {
  const parts = [u.minutes > 0 ? `${formatDuration(u.minutes * 60)} logged` : null, u.note ? 'note included' : null, u.stuck ? 'marked stuck' : null].filter(
    (p): p is string => p !== null,
  );
  const line = parts.join(' · ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}

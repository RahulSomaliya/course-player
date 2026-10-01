// The sign-off card's auto summary (docs/spec-v2-coaching.md "Sign-off card"): what she studied since
// her last sign-off, so there is nothing for her to fill in at the top — only a note, a mood, "stuck".
import type { Course } from '../../../shared/types';
import { dayOfWeekLabel, daysBetween, localDateKey } from './dates';
import { formatDuration, formatShortDate } from './format';
import { sectionShortName } from './outline';
import { MIN_SEND_SECONDS, mainSection, type SignOffTarget } from './session';

/** lecture titles listed before "+N more" */
const MAX_TITLES = 5;

export interface TargetSummary {
  heading: string;
  /** under the heading for an earlier session */
  question: string | null;
  /** "1h 12m"; null for a note-only update */
  studied: string | null;
  /** "§07 Thinking In React - State Management" */
  section: string | null;
  lectures: { shown: string[]; more: number };
  /** under 5 min (or nothing studied): only sent with a note */
  needsNote: boolean;
}

function when(startedAt: number, now: number): string {
  const day = localDateKey(new Date(startedAt));
  const ago = daysBetween(day, localDateKey(new Date(now)));
  if (ago <= 0) return 'earlier today';
  if (ago === 1) return 'yesterday';
  if (ago < 7) return `on ${dayOfWeekLabel(day)}`;
  return `on ${formatShortDate(day)}`;
}

export function describeTarget(target: SignOffTarget, course: Course, name: string, now: number): TargetSummary {
  if (target.kind === 'note') {
    return { heading: 'A note for Rahul', question: null, studied: null, section: null, lectures: { shown: [], more: 0 }, needsNote: true };
  }
  const s = target.session;
  const studied = formatDuration(s.seconds);
  const section = course.sections.find((x) => x.number === mainSection(s));
  const titles = s.lecturesCompleted.map((l) => l.title);
  return {
    heading: target.kind === 'pending' ? `You studied ${studied} ${when(s.startedAt, now)}` : `Nice work, ${name}`,
    question: target.kind === 'pending' ? 'Add a note for Rahul?' : null,
    studied,
    section: section ? sectionShortName(section) : null,
    lectures: { shown: titles.slice(0, MAX_TITLES), more: Math.max(0, titles.length - MAX_TITLES) },
    needsNote: s.seconds < MIN_SEND_SECONDS,
  };
}

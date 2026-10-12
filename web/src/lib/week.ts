// "This week" + the Due stat, from JourneyStatus (docs/spec-v2-coaching.md "This week + stats").
// The Due stat is her plan's target (`targetDate`, "Fri 25 Dec"). During a plan break (Diwali) there is
// no pace to keep, so both say "break" instead. v4 (docs/spec-v4-pace-and-coach.md): JS Journey also
// sends where her CURRENT pace lands (`projection`) — a quiet line at the bottom of This week
// (projectionLine), never a second Due number.
import type { JourneyStatus, PaceProjection } from '../../../shared/types';
import { addDays } from './dates';
import { formatDay, formatDuration, sectionNumberLabel } from './format';

export interface WeekView {
  week: string;
  goal: { text: string; due: string } | null;
  /** null during a break */
  pace: { label: string; tone: 'good' | 'quiet' } | null;
  onBreak: { label: string; back: string } | null;
  /** a break starting within 14 days (JS Journey only sends those) */
  upcomingBreak: string | null;
  // No course due date: the Due stat right below shows it (dueStat) — This week printed it twice
  // (Rahul, 2026-10-01). Mirror: JS Journey lib/journey-view.ts weekView.
}

function days(n: number): string {
  const abs = Math.abs(n);
  return `${abs} ${abs === 1 ? 'day' : 'days'}`;
}

/** The pace pill AND the Due stat's word, read from the study days alone — never a bare "Behind"/"Ahead".
 *  Mirror of JS Journey lib/journey-view.ts paceLabel: its status once paired pace "behind" with 0 days
 *  (two models), and the loudest line on home said "Behind" while the plan said on schedule. JS Journey
 *  now derives both from one model (lib/status.ts planPace); the days decide either way. */
function paceOf(s: JourneyStatus): NonNullable<WeekView['pace']> {
  if (s.daysDelta > 0) return { label: `Ahead by ${days(s.daysDelta)}`, tone: 'good' };
  if (s.daysDelta < 0) return { label: `Behind by ${days(s.daysDelta)}`, tone: 'quiet' };
  return { label: 'On track', tone: 'good' };
}

/** The break in progress today, else null. `?? null`: a JS Journey deployed before planBreak omits it. */
export function activeBreak(s: JourneyStatus, today: string): JourneyStatus['planBreak'] {
  const brk = s.planBreak ?? null;
  return brk !== null && brk.start <= today && today <= brk.end ? brk : null;
}

export function describeWeek(s: JourneyStatus, today: string): WeekView {
  const brk = s.planBreak ?? null;
  const active = activeBreak(s, today);
  return {
    week: `Week ${s.week} of ${s.totalWeeks}`,
    goal: s.goal ? { text: `Finish ${sectionNumberLabel(s.goal.sectionNumber)} ${s.goal.title}`, due: formatDay(s.goal.due) } : null,
    pace: active ? null : paceOf(s),
    onBreak: active ? { label: active.label, back: formatDay(addDays(active.end, 1)) } : null,
    upcomingBreak: brk !== null && brk.start > today ? `${brk.label} from ${formatDay(brk.start)} to ${formatDay(brk.end)}` : null,
  };
}

/** The stats row's 4th number. null (omitted) when no status is known — live or cached. Its word is the
 *  pill's own label (paceOf): a separate word map printed a bare "Behind". */
export function dueStat(s: JourneyStatus | null, today: string): { value: string; hint: string } | null {
  if (s === null) return null;
  const active = activeBreak(s, today);
  return { value: formatDay(s.targetDate), hint: active ? active.label : paceOf(s).label };
}

/** study days in a plan week — the unit "≥ 5 study days → weeks" counts in (spec v4 "Projection") */
const STUDY_DAYS_PER_WEEK = 5;
/** |vsTarget| under this many study days reads "right around your target" */
const AROUND_TARGET_DAYS = 3;

function studyDaysPhrase(n: number): string {
  if (n >= STUDY_DAYS_PER_WEEK) {
    const weeks = Math.round(n / STUDY_DAYS_PER_WEEK);
    return `${weeks} ${weeks === 1 ? 'week' : 'weeks'}`;
  }
  return days(n);
}

/** "At your pace — about 1h 25m of lectures a study day — you’ll finish around **Fri 27 Nov**, 4 weeks
 *  before your target." Split around the date (This week makes it the one strong word); null while JS
 *  Journey has no projection (no snapshot / < 2 study days yet) or predates it. Mirror of JS Journey
 *  lib/journey-view.ts projectionLine (coach: "her" / "she’ll"), one test table (its PROJECTION_CASES,
 *  verbatim): change both together — curly apostrophe, rate rounded like its fmtDur. */
export function projectionLine(p: PaceProjection | null | undefined): { lead: string; date: string; tail: string; text: string } | null {
  if (p === null || p === undefined) return null;
  const rate = formatDuration(Math.max(0, Math.round(p.minutesPerStudyDay)) * 60);
  const lead = `At your pace — about ${rate} of lectures a study day — you’ll finish around `;
  const date = formatDay(p.finish);
  const off = Math.abs(p.vsTarget);
  const tail =
    off < AROUND_TARGET_DAYS ? ', right around your target.' : `, ${studyDaysPhrase(off)} ${p.vsTarget > 0 ? 'before' : 'after'} your target.`;
  return { lead, date, tail, text: `${lead}${date}${tail}` };
}

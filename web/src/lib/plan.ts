// Her whole plan (docs/spec-v3-study-timer.md A7): JourneyStatus.plan is exactly the coach page's rows
// (JS Journey lib/journey-view.ts planRows), so she sees the plan Rahul sees. Same words as the coach
// list (components/coach/plan-list.tsx there): ✓ for done, "This week", "Behind"; upcoming and past
// "keep going" weeks are quiet. State is a mark or a word, never colour alone. Change both together.
import type { PlanRow } from '../../../shared/types';
import { addDays, isoWeekday } from './dates';
import { formatDay, formatShortDate } from './format';

export type PlanRowView =
  | {
      kind: 'week';
      key: string;
      title: string;
      goal: string;
      /** "Fri 9 Oct" — the Friday the week's goal is due */
      due: string;
      mark: 'done' | 'current' | 'open';
      tag: 'This week' | 'Behind' | null;
      /** the state for a screen reader (the mark is aria-hidden) */
      srState: 'done' | 'this week' | 'behind' | 'upcoming' | 'keep going';
      /** upcoming / past weeks: recessive text */
      quiet: boolean;
    }
  | { kind: 'break'; key: string; title: string; tag: 'Now' | null; dates: string; detail: string };

const SR_STATE = { done: 'done', current: 'this week', behind: 'behind', upcoming: 'upcoming', past: 'keep going' } as const;

/** Study days in [start, end] on her plan's weekdays (ISO 1 = Mon … 7 = Sun). */
function studyDaysIn(start: string, end: string, studyWeekdays: readonly number[]): number {
  let n = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) if (studyWeekdays.includes(isoWeekday(d))) n++;
  return n;
}

export function planView(rows: readonly PlanRow[], studyWeekdays: readonly number[]): PlanRowView[] {
  return rows.map((r): PlanRowView => {
    if (r.kind === 'break') {
      const off = studyDaysIn(r.start, r.end, studyWeekdays);
      return {
        kind: 'break',
        key: `b${r.start}`,
        title: `${r.label} break`,
        tag: r.now ? 'Now' : null,
        dates: `${formatShortDate(r.start)} – ${formatShortDate(r.end)}`,
        detail: `${off} study ${off === 1 ? 'day' : 'days'} off — every date here already skips ${off === 1 ? 'it' : 'them'}.`,
      };
    }
    return {
      kind: 'week',
      key: `w${r.week}`,
      title: `Week ${r.week}`,
      goal: r.goal,
      due: formatDay(r.due),
      mark: r.state === 'done' ? 'done' : r.state === 'current' ? 'current' : 'open',
      tag: r.state === 'current' ? 'This week' : r.state === 'behind' ? 'Behind' : null,
      srState: SR_STATE[r.state],
      quiet: r.state === 'upcoming' || r.state === 'past',
    };
  });
}

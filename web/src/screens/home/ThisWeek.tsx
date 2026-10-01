// "This week", from her JS Journey plan: Week 3 of 10 · the week's goal · pace. Not the course due
// date — the Due stat right below shows it. During a break (Diwali) it says so warmly instead of a
// pace. No status (not connected, nothing cached) → no block. Never blocks the page.
import { CalendarHeart } from 'lucide-react';
import type { JourneyStatus } from '../../../../shared/types';
import { todayKey } from '../../lib/dates';
import { describeWeek } from '../../lib/week';

export function ThisWeek({ status }: { status: JourneyStatus | null }) {
  if (status === null) return null;
  const w = describeWeek(status, todayKey());
  return (
    <section aria-labelledby="week-title">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="week-title" className="text-base font-semibold text-ink">
          This week
        </h2>
        <p className="text-sm tabular-nums text-ink-muted">{w.week}</p>
      </div>
      <div className="mt-4 flex flex-col gap-4 rounded-lg border border-line bg-surface px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-8 sm:px-6">
        {w.onBreak ? (
          <div className="flex items-start gap-3">
            <CalendarHeart className="mt-0.5 size-5 shrink-0 text-accent" strokeWidth={1.5} aria-hidden="true" />
            <div>
              <p className="text-base font-medium text-ink">
                {w.onBreak.label} · back {w.onBreak.back}
              </p>
              <p className="mt-0.5 text-sm text-ink-muted">Enjoy it — break days are not study days, so no pace is lost.</p>
            </div>
          </div>
        ) : (
          w.goal && (
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-[0.06em] text-ink-muted">Goal</p>
              <p className="mt-1 text-base font-medium text-ink">
                {w.goal.text} <span className="font-normal text-ink-muted">by {w.goal.due}</span>
              </p>
            </div>
          )
        )}
        {w.pace && (
          <span
            className={`inline-flex h-7 shrink-0 items-center self-start rounded-full px-3 text-sm font-medium sm:self-center ${
              w.pace.tone === 'good' ? 'bg-accent-soft text-accent-ink' : 'bg-fill text-ink'
            }`}
          >
            {w.pace.label}
          </span>
        )}
      </div>
      {w.upcomingBreak && <p className="mt-2 text-sm text-ink-muted">{w.upcomingBreak}</p>}
    </section>
  );
}

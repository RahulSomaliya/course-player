// "This week", from her JS Journey plan: Week 3 of 10 · the week's goal · pace. Not the course due
// date — the Due stat right below shows it. During a break (Diwali) it says so warmly instead of a
// pace. No status (not connected, nothing cached) → no block. Never blocks the page.
// v3 (spec A7): a quiet "See full plan" opens her whole plan below (Collapse, 220 ms; instant under
// reduced motion) — the coach page's rows (JourneyStatus.plan), so she sees the plan Rahul sees. No
// plan (an older JS Journey, a status cached before it) → no toggle. Works offline from the cache.
import { CalendarDays, CalendarHeart, Check, ChevronDown } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import type { JourneyStatus } from '../../../../shared/types';
import { Collapse } from '../../components/Collapse';
import { todayKey } from '../../lib/dates';
import { planView, type PlanRowView } from '../../lib/plan';
import { describeWeek } from '../../lib/week';

export function ThisWeek({ status }: { status: JourneyStatus | null }) {
  const [open, setOpen] = useState(false);
  const planId = useId();
  const plan = status?.plan;
  const rows = useMemo(() => (plan && plan.length > 0 && status ? planView(plan, status.studyWeekdays) : null), [plan, status]);
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
      {(w.upcomingBreak || rows) && (
        <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          {w.upcomingBreak && <p className="text-sm text-ink-muted">{w.upcomingBreak}</p>}
          {rows && (
            <button
              type="button"
              data-control="full-plan"
              aria-expanded={open}
              aria-controls={planId}
              onClick={() => setOpen((o) => !o)}
              className="ml-auto inline-flex items-center gap-1 rounded-sm text-sm font-medium text-accent-ink underline-offset-4 hover:underline"
            >
              {open ? 'Hide full plan' : 'See full plan'}
              <ChevronDown className={`size-4 transition-transform duration-200 ease-out ${open ? 'rotate-180' : ''}`} strokeWidth={1.5} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
      {rows && (
        <Collapse open={open} id={planId}>
          {() => <PlanList rows={rows} />}
        </Collapse>
      )}
    </section>
  );
}

/** The plan, week by week — the look of JS Journey's coach plan list (components/coach/plan-list.tsx) in
 *  this app's tokens: a mark, the week + its state word, the goal, the Friday it is due. */
function PlanList({ rows }: { rows: PlanRowView[] }) {
  return (
    <ol data-plan aria-label="Your plan, week by week" className="mt-4 divide-y divide-line border-y border-line">
      {rows.map((r) =>
        r.kind === 'week' ? (
          <li key={r.key} className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-start gap-x-3 py-3">
            <PlanMark mark={r.mark} />
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink">
                {r.title}
                {r.tag && <span className={`ml-2 font-medium ${r.tag === 'This week' ? 'text-accent-ink' : 'text-ink-muted'}`}>{r.tag}</span>}
                {!r.tag && <span className="sr-only"> — {r.srState}</span>}
              </p>
              <p className={`mt-0.5 text-sm ${r.quiet ? 'text-ink-subtle' : 'text-ink-muted'}`}>{r.goal}</p>
            </div>
            <p className={`text-sm tabular-nums ${r.quiet ? 'text-ink-subtle' : 'text-ink-muted'}`}>{r.due}</p>
          </li>
        ) : (
          <li key={r.key} className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-start gap-x-3 py-3">
            <CalendarDays className="mt-0.5 size-4 text-ink-muted" strokeWidth={1.5} aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink">
                {r.title}
                {r.tag && <span className="ml-2 font-medium text-accent-ink">{r.tag}</span>}
              </p>
              <p className="mt-0.5 text-sm text-ink-muted">{r.detail}</p>
            </div>
            <p className="text-sm tabular-nums text-ink-muted">{r.dates}</p>
          </li>
        ),
      )}
    </ol>
  );
}

/** done = an accent ✓ · this week = an accent dot · otherwise a hairline circle. Static: a state
 *  indicator never transitions its colour (docs/design.md). */
function PlanMark({ mark }: { mark: 'done' | 'current' | 'open' }) {
  if (mark === 'done') return <Check className="mt-0.5 size-4 text-accent" strokeWidth={2} aria-hidden="true" />;
  if (mark === 'current') return <span aria-hidden="true" className="ml-1 mt-1.5 block size-2 rounded-full bg-accent" />;
  return <span aria-hidden="true" className="ml-0.5 mt-1 block size-3 rounded-full border border-line" />;
}

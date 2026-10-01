// At most 4 numbers: Today, Streak, Complete, Left. A quiet row — no cards, hairline dividers.
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { useApp } from '../../app/context';
import { todayKey } from '../../lib/dates';
import { formatDuration, formatShortDate } from '../../lib/format';
import { completion, streak, studiedOn, timeLeft } from '../../lib/stats';
import { useProgress } from '../../state/progress';

export function Stats() {
  const { course } = useApp();
  const days = useProgress((s) => s.days);
  const lectures = useProgress((s) => s.lectures);
  const today = todayKey();
  const done = useMemo(() => completion(course, lectures), [course, lectures]);
  const left = useMemo(() => timeLeft(course, lectures, days, today), [course, lectures, days, today]);
  const run = streak(days, today);
  const pct = done.percent;
  const pctLabel = pct > 0 && pct < 1 ? '<1%' : `${Math.floor(pct)}%`;

  return (
    <dl className="grid grid-cols-2 gap-y-8 border-y border-line py-6 md:grid-cols-4 md:gap-y-0">
      <Stat label="Today" value={formatDuration(studiedOn(days, today))} />
      <Stat label="Streak" value={`${run} ${run === 1 ? 'day' : 'days'}`} hint={run === 0 ? '5 min a day counts' : undefined} />
      <Stat label="Complete" value={pctLabel} hint={`${done.doneLectures} / ${done.totalLectures} lectures`} />
      <Stat label="Left" value={formatDuration(left.remaining)} hint={left.remaining > 0 ? `finish ≈ ${left.eta ? formatShortDate(left.eta, today) : '—'}` : undefined} />
    </dl>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: ReactNode }) {
  return (
    <div className="px-1 md:border-l md:border-line md:px-6 md:first:border-l-0 md:first:pl-1">
      <dt className="text-sm text-ink-muted">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold text-ink">{value}</dd>
      {hint && <dd className="mt-1 text-sm text-ink-subtle">{hint}</dd>}
    </div>
  );
}

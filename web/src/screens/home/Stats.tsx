// At most 4 numbers: Today, Streak, Complete, Due. A quiet row — no cards, hairline dividers.
// Due = her plan's course target date + a pace word (lib/week.ts dueStat); not connected and nothing
// cached → it is omitted. On the first paint of home the numbers count up from 0 (CountUp) — once the
// row is in view, not at mount (it is usually below the fold).
import { useMemo, useRef, type ReactNode } from 'react';
import type { JourneyStatus } from '../../../../shared/types';
import { useApp } from '../../app/context';
import { CountUp } from '../../components/CountUp';
import { todayKey } from '../../lib/dates';
import { formatDuration } from '../../lib/format';
import { useSeenOnce } from '../../lib/motion';
import { completion, streak, studiedOn, studyCalendar } from '../../lib/stats';
import { activeBreak, dueStat } from '../../lib/week';
import { useProgress } from '../../state/progress';

const pctLabel = (pct: number): string => (pct > 0 && pct < 1 ? '<1%' : `${Math.floor(pct)}%`);
const days = (n: number): string => {
  const whole = Math.round(n);
  return `${whole} ${whole === 1 ? 'day' : 'days'}`;
};

export function Stats({ status, intro }: { status: JourneyStatus | null; intro: boolean }) {
  const { course } = useApp();
  const daysStudied = useProgress((s) => s.days);
  const lectures = useProgress((s) => s.lectures);
  const today = todayKey();
  const done = useMemo(() => completion(course, lectures), [course, lectures]);
  // study days, not calendar days: a quiet weekend or Diwali no longer resets it (lib/stats.ts)
  const run = streak(daysStudied, today, studyCalendar(status));
  const due = dueStat(status, today);
  // "5 min a day counts" says how a 0 streak starts again — never on a break day: it would ask her to
  // study right under "break days are not study days" (JS Journey review 2026-10-01; mirror: its
  // components/stats-row.tsx)
  const nudge = run === 0 && (status === null || activeBreak(status, today) === null);
  const row = useRef<HTMLDListElement>(null);
  const play = useSeenOnce(row, intro);

  return (
    <dl ref={row} className={`grid grid-cols-2 gap-y-8 border-y border-line py-6 ${due ? 'md:grid-cols-4' : 'md:grid-cols-3'} md:gap-y-0`}>
      <Stat label="Today" value={<CountUp value={studiedOn(daysStudied, today)} format={formatDuration} animate={intro} play={play} />} />
      <Stat label="Streak" value={<CountUp value={run} format={days} animate={intro} play={play} />} hint={nudge ? '5 min a day counts' : undefined} />
      <Stat
        label="Complete"
        value={<CountUp value={done.percent} format={pctLabel} animate={intro} play={play} />}
        hint={`${done.doneLectures} / ${done.totalLectures} lectures`}
      />
      {due && <Stat label="Due" value={due.value} hint={due.hint} />}
    </dl>
  );
}

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="px-1 md:border-l md:border-line md:px-6 md:first:border-l-0 md:first:pl-1">
      <dt className="text-sm text-ink-muted">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums text-ink">{value}</dd>
      {hint && <dd className="mt-1 text-sm text-ink-subtle">{hint}</dd>}
    </div>
  );
}

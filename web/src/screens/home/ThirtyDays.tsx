// Last 30 days of study time (dataviz skill): one series → no legend; thin bars (≤ 20 px, 4 px rounded
// tops, square at the baseline); today in the accent, other days in `chart-bar`; one hairline average
// line labelled at its end; a per-bar hover/focus tooltip ("Tue 29 Sep · 1h 12m"); a visually hidden
// table carries every value, so nothing is gated behind hovering.
import { useMemo, useState, type KeyboardEvent } from 'react';
import { todayKey } from '../../lib/dates';
import { formatDay, formatDuration, formatShortDate } from '../../lib/format';
import { last30 } from '../../lib/stats';
import { useProgress } from '../../state/progress';

/** Clean top of the scale: at least 1 h, then the next whole half hour (≤ 3 h) or hour. */
function niceTop(seconds: number): number {
  const half = 1800;
  if (seconds <= 3600) return 3600;
  if (seconds <= 3 * 3600) return Math.ceil(seconds / half) * half;
  return Math.ceil(seconds / 3600) * 3600;
}

export function ThirtyDays() {
  const days = useProgress((s) => s.days);
  const today = todayKey();
  const { days: series, average } = useMemo(() => last30(days, today), [days, today]);
  const [active, setActive] = useState<number | null>(null);
  const top = niceTop(Math.max(average, ...series.map((d) => d.seconds)));
  const empty = series.every((d) => d.seconds < 60);
  const pct = (s: number): number => (s / top) * 100;
  const shown = active === null ? null : series[active];

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    setActive((i) => {
      if (e.key === 'Home') return 0;
      if (e.key === 'End') return series.length - 1;
      const from = i ?? series.length - 1;
      return Math.max(0, Math.min(series.length - 1, from + (e.key === 'ArrowLeft' ? -1 : 1)));
    });
  };

  return (
    <section aria-labelledby="thirty-title">
      <h2 id="thirty-title" className="text-base font-semibold text-ink">
        Last 30 days
      </h2>
      <div
        role="group"
        aria-label="Daily study time for the last 30 days. Use the arrow keys to read each day."
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
        className="relative mt-4 h-40 rounded-sm"
      >
        {/* scale: top gridline + baseline, hairline and recessive */}
        <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-line" aria-hidden="true">
          <span className="absolute left-0 top-1 text-xs tabular-nums text-ink-subtle">{formatDuration(top)}</span>
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 border-t border-line" aria-hidden="true" />

        {empty && (
          <p className="absolute inset-0 flex items-center justify-center text-sm text-ink-muted">Your study time will show up here, day by day.</p>
        )}

        <div className="absolute inset-0 flex items-end gap-0.5" aria-hidden="true">
          {series.map((d, i) => {
            const isToday = d.key === today;
            const isActive = i === active;
            const h = d.seconds > 0 ? Math.max(pct(d.seconds), 1.5) : 0;
            const fill = isToday ? (isActive ? 'bg-accent-hover' : 'bg-accent') : isActive ? 'bg-chart-bar-hover' : 'bg-chart-bar';
            return (
              <div key={d.key} data-day={d.key} className="flex h-full flex-1 items-end justify-center" onPointerEnter={() => setActive(i)}>
                <div className={`w-full max-w-5 rounded-t-sm ${fill}`} style={{ height: `${h}%` }} />
              </div>
            );
          })}
        </div>

        {average >= 60 && (
          <div className="pointer-events-none absolute inset-x-0 border-t border-ink-subtle" style={{ bottom: `${pct(average)}%` }} aria-hidden="true">
            <span className="absolute -top-5 right-0 rounded-sm bg-canvas px-1 text-xs tabular-nums text-ink-muted">avg {formatDuration(average)}</span>
          </div>
        )}

        {shown && active !== null && (
          <div
            role="status"
            className="pointer-events-none absolute z-10 whitespace-nowrap rounded-md border border-line bg-raised px-2.5 py-1.5 text-sm shadow-e2"
            style={{
              left: `${((active + 0.5) / series.length) * 100}%`,
              bottom: `calc(${Math.min(pct(shown.seconds), 100)}% + 8px)`,
              transform: `translateX(${active < 4 ? '-15%' : active > series.length - 5 ? '-85%' : '-50%'})`,
            }}
          >
            <span className="font-semibold tabular-nums text-ink">{formatDuration(shown.seconds)}</span>
            <span className="text-ink-muted"> · {shown.key === today ? 'Today' : formatDay(shown.key)}</span>
          </div>
        )}
      </div>
      <div className="mt-2 flex justify-between text-xs text-ink-subtle" aria-hidden="true">
        <span>{formatShortDate(series[0]?.key ?? today)}</span>
        <span>Today</span>
      </div>
      <table className="sr-only">
        <caption>Study time per day, last 30 days</caption>
        <tbody>
          {series.map((d) => (
            <tr key={d.key}>
              <th scope="row">{formatDay(d.key)}</th>
              <td>{formatDuration(d.seconds)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

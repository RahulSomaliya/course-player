// Last 30 days of study time (dataviz skill): one series → no legend; thin bars (≤ 20 px, 4 px rounded
// tops, square at the baseline); today in the accent, other days in `chart-bar`; one hairline average
// line labelled at its end — in a right gutter OUTSIDE the plot: drawn over the plot, its label (with
// a canvas-coloured box) cut through the most recent bars on a phone (2026-10-01 review); a per-bar
// hover/focus tooltip ("Tue 29 Sep · 1h 12m"); a visually hidden table carries every value, so nothing
// is gated behind hovering.
// Motion: on the first paint of home the bars grow from the baseline with a 12 ms stagger — from a
// quarter of their height, never from nothing (a screenshot or a skipped animation shows real bars) —
// once the chart is in view (held at that quarter until then; lib/motion.ts useSeenOnce).
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { todayKey } from '../../lib/dates';
import { formatDay, formatDuration, formatShortDate } from '../../lib/format';
import { useSeenOnce } from '../../lib/motion';
import { last30 } from '../../lib/stats';
import { useStudyDays } from '../../state/study';

/** Clean top of the scale: at least 1 h, then the next whole half hour (≤ 3 h) or hour. */
function niceTop(seconds: number): number {
  const half = 1800;
  if (seconds <= 3600) return 3600;
  if (seconds <= 3 * 3600) return Math.ceil(seconds / half) * half;
  return Math.ceil(seconds / 3600) * 3600;
}

export function ThirtyDays({ intro }: { intro: boolean }) {
  // + the running timer (display only — days are written at sign-off, state/study.ts)
  const days = useStudyDays();
  const today = todayKey();
  const { days: series, average } = useMemo(() => last30(days, today), [days, today]);
  const [active, setActive] = useState<number | null>(null);
  const top = niceTop(Math.max(average, ...series.map((d) => d.seconds)));
  const empty = series.every((d) => d.seconds < 60);
  const pct = (s: number): number => (s / top) * 100;
  const shown = active === null ? null : series[active];
  const plot = useRef<HTMLDivElement>(null);
  const play = useSeenOnce(plot, intro);

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
        className="mt-4 rounded-sm pr-20"
      >
        <div ref={plot} className="relative h-40">
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
                  <div
                    className={`w-full max-w-5 origin-bottom rounded-t-sm ${fill} ${intro ? 'animate-bar-rise' : ''}`}
                    style={{
                      height: `${h}%`,
                      animationDelay: intro ? `${i * 12}ms` : undefined,
                      // paused = held at the first keyframe (25 %, `backwards`) until the chart is in view
                      animationPlayState: intro && !play ? 'paused' : undefined,
                    }}
                  />
                </div>
              );
            })}
          </div>

          {average >= 60 && (
            <div className="pointer-events-none absolute inset-x-0 border-t border-ink-subtle" style={{ bottom: `${pct(average)}%` }} aria-hidden="true">
              {/* in the gutter (pr-20 above), level with the line — never over the bars */}
              <span className="absolute left-full top-0 -translate-y-1/2 whitespace-nowrap pl-2 text-xs tabular-nums text-ink-muted">avg {formatDuration(average)}</span>
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
      </div>
      <div className="mt-2 flex justify-between pr-20 text-xs text-ink-subtle" aria-hidden="true">
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

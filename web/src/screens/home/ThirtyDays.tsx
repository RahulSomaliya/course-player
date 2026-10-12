// Last 30 days of study time (dataviz skill): one series → no legend; thin bars (≤ 20 px, 4 px rounded
// tops, square at the baseline); one hairline average line labelled at its end — in a right gutter
// OUTSIDE the plot: drawn over the plot, its label (with a canvas-coloured box) cut through the most
// recent bars on a phone (2026-10-01 review); a per-bar hover/focus tooltip ("Tue 29 Sep · 1h 12m"); a
// visually hidden table carries every value, so nothing is gated behind hovering.
// v4 (docs/spec-v4-pace-and-coach.md "Chart + daily goal"): a day at or over her daily goal is `accent`
// with a small accent ✓ above it; every other day — today included — is `chart-bar`: no goal line, no
// "x min left", nothing marks a short day. Without a goal (an older JS Journey, not connected) there are
// no goal visuals at all and today is the accent, as in v3. The "avg" is lib/stats.ts studyAverage (from
// her start, over plan study days) — over all 30 days her 2 h a day in week 1 read "avg 24m".
// Motion: on the first paint of home the bars grow from the baseline with a 12 ms stagger — from a
// quarter of their height, never from nothing (a screenshot or a skipped animation shows real bars) —
// once the chart is in view (held at that quarter until then; lib/motion.ts useSeenOnce). The goal
// moment (lib/goal-moment.ts): today's bar lifts once (`goal-rise`, from 82 %) and its ✓ draws in after.
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { JourneyStatus } from '../../../../shared/types';
import { GoalCheck } from '../../components/ui';
import { formatDay, formatDuration, formatShortDate } from '../../lib/format';
import { useSeenOnce } from '../../lib/motion';
import { goalMet, last30, studyAverage, studyCalendar } from '../../lib/stats';

/** the goal moment's ✓ starts drawing as the bar's rise settles: 300 + 260 ms ≤ the 600 ms budget */
const MOMENT_CHECK_DELAY_MS = 300;
/** `bar-rise` (index.css): the first-paint rise a met bar's ✓ waits on */
const BAR_RISE_MS = 520;

/** Clean top of the scale: at least 1 h, then the next whole half hour (≤ 3 h) or hour. */
function niceTop(seconds: number): number {
  const half = 1800;
  if (seconds <= 3600) return 3600;
  if (seconds <= 3 * 3600) return Math.ceil(seconds / half) * half;
  return Math.ceil(seconds / 3600) * 3600;
}

interface Props {
  status: JourneyStatus | null;
  /** ProgressState.days + the running timer (display only — days are written at sign-off, state/study.ts) */
  days: Record<string, number>;
  today: string;
  intro: boolean;
  /** the once-a-day goal moment is playing on this mount (lib/goal-moment.ts, owned by StudyNumbers) */
  moment: boolean;
}

export function ThirtyDays({ status, days, today, intro, moment }: Props) {
  const series = useMemo(() => last30(days, today), [days, today]);
  const average = useMemo(() => studyAverage(days, today, studyCalendar(status), status?.startDate ?? null), [days, today, status]);
  const goal = status?.dailyGoalMinutes;
  const [active, setActive] = useState<number | null>(null);
  const top = niceTop(Math.max(average, ...series.map((d) => d.seconds)));
  const empty = series.every((d) => d.seconds < 60);
  const pct = (s: number): number => (s / top) * 100;
  const shown = active === null ? null : series[active];
  const plot = useRef<HTMLDivElement>(null);
  const play = useSeenOnce(plot, intro);
  const momentSeen = useSeenOnce(plot, moment);
  // `intro` stays true for this whole mount: a moment already there at the first paint rides the intro's
  // rise; one that comes LATER (crossed live while home is open) must not — its bar would keep the
  // finished bar-rise and never lift, and its new ✓ would wait on the intro's 0.9 s of delays
  const [momentAtFirstPaint] = useState(() => intro && moment);

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
              const met = goalMet(d.seconds, goal);
              // goal-met days are the accent; without a goal, today is (v3) — never a colour transition
              const accent = goal === undefined ? isToday : met;
              const rising = moment && isToday && met;
              // the goal moment's own lift — except at the first paint, where the bar rises anyway (bar-rise)
              const lifting = rising && !momentAtFirstPaint;
              const h = d.seconds > 0 ? Math.max(pct(d.seconds), 1.5) : 0;
              const fill = accent ? (isActive ? 'bg-accent-hover' : 'bg-accent') : isActive ? 'bg-chart-bar-hover' : 'bg-chart-bar';
              const motion = lifting ? 'animate-goal-rise' : intro ? 'animate-bar-rise' : '';
              return (
                <div key={d.key} data-day={d.key} className="relative flex h-full flex-1 items-end justify-center" onPointerEnter={() => setActive(i)}>
                  {met && (
                    // first paint: the ✓ arrives (from 40 %) as its bar rises into place, never floating alone
                    <span
                      className={`absolute left-1/2 -translate-x-1/2 ${intro && !lifting ? 'animate-arrive' : ''}`}
                      style={{
                        bottom: `calc(${Math.min(h, 100)}% + 4px)`,
                        animationDelay: intro && !lifting ? `${i * 12 + BAR_RISE_MS / 2}ms` : undefined,
                        animationPlayState: intro && !lifting && !play ? 'paused' : undefined,
                      }}
                    >
                      <GoalCheck
                        className="block size-2 sm:size-3"
                        draw={rising}
                        hold={lifting ? !momentSeen : !play}
                        delayMs={lifting ? MOMENT_CHECK_DELAY_MS : i * 12 + BAR_RISE_MS}
                      />
                    </span>
                  )}
                  <div
                    data-bar
                    className={`w-full max-w-5 origin-bottom rounded-t-sm ${fill} ${motion}`}
                    style={{
                      height: `${h}%`,
                      animationDelay: intro && !lifting ? `${i * 12}ms` : undefined,
                      // paused = held at the first keyframe (25 % / 82 %, `backwards`) until the chart is in view
                      animationPlayState: (lifting ? !momentSeen : intro && !play) ? 'paused' : undefined,
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
              <td>
                {formatDuration(d.seconds)}
                {goalMet(d.seconds, goal) ? ' · daily goal met' : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

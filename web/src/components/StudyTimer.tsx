// The study timer's controls (docs/spec-v3-study-timer.md A4): "Start studying" (header + home) when no
// session runs; while one runs, the header chip "● 1h 23m" that reads "Sign off" on hover AND keyboard
// focus; and the quiet "Study timer started" notice after a lecture auto-started it.
// The chip is a STATE INDICATOR: no colour transition anywhere on it (a screenshot caught v2's dot
// mid-fade — docs/design.md), and both labels share one grid cell so the swap never moves its neighbours.
import { Timer } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useApp } from '../app/context';
import { formatElapsed, formatSpokenDuration } from '../lib/format';
import { timerSeconds } from '../lib/session';
import { useNow, useStudy, useStudyState } from '../state/study';
import { buttonClass } from './ui';

/** how long "Study timer started" stays (reading time, kept under reduced motion — only its pop-in goes) */
const NOTICE_MS = 4000;

/** Header: Start studying, or the running chip — with the auto-start notice under it. */
export function HeaderTimer() {
  const { session, notice } = useStudyState();
  return (
    <div className="relative">
      {session === null ? <StartStudying size="header" /> : <TimerChip startedAt={session.startedAt} />}
      <TimerNotice notice={notice} />
    </div>
  );
}

/** "Start studying": a calm pill in the header, a secondary button on home (Continue stays THE primary). */
export function StartStudying({ size }: { size: 'header' | 'hero' }) {
  const study = useStudy();
  const className =
    size === 'header'
      ? 'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-surface px-3 text-sm font-medium text-ink transition-[background-color] duration-150 ease-out hover:bg-fill'
      : buttonClass('secondary', 'lg');
  return (
    <button type="button" data-control={size === 'header' ? 'start-studying' : 'start-studying-hero'} onClick={() => study.startSession()} className={className}>
      <Timer className="size-4 text-accent" strokeWidth={1.75} aria-hidden="true" />
      Start studying
    </button>
  );
}

function TimerChip({ startedAt }: { startedAt: number }) {
  const { openSignOff } = useApp();
  const now = useNow(true);
  const seconds = timerSeconds({ startedAt }, now);
  return (
    <button
      type="button"
      onClick={openSignOff}
      aria-label={`Sign off — studying for ${formatSpokenDuration(seconds)}`}
      data-control="sign-off"
      className="group inline-grid h-8 shrink-0 items-center whitespace-nowrap rounded-full border border-line bg-surface px-3 text-sm font-medium text-ink hover:bg-fill"
    >
      <span aria-hidden="true" data-label="timer" className="col-start-1 row-start-1 inline-flex items-center justify-center gap-1.5 tabular-nums group-hover:invisible group-focus-visible:invisible">
        <span className="size-2 rounded-full bg-accent" />
        {formatElapsed(seconds)}
      </span>
      <span aria-hidden="true" data-label="sign-off" className="invisible col-start-1 row-start-1 text-center group-hover:visible group-focus-visible:visible">
        Sign off
      </span>
    </button>
  );
}

/** A polite live region that is always there (an inserted one is often not announced); the words come
 *  and go. Shown for what is left of NOTICE_MS since the auto-start, so a remount (Home → Watch) neither
 *  repeats it in full nor loses it. */
function TimerNotice({ notice }: { notice: { at: number } | null }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (notice === null) return;
    const left = notice.at + NOTICE_MS - Date.now();
    setShown(left > 0);
    if (left <= 0) return;
    const t = window.setTimeout(() => setShown(false), left);
    return () => window.clearTimeout(t);
  }, [notice]);
  return (
    <div role="status" className="pointer-events-none absolute right-0 top-10 z-40">
      {shown && (
        <p data-notice="timer-started" className="animate-pop-in whitespace-nowrap rounded-md border border-line bg-raised px-3 py-1.5 text-sm text-ink-muted shadow-e2">
          Study timer started
        </p>
      )}
    </div>
  );
}

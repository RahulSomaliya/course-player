// End of a lecture: "Up next" card. With prefs.autoplay a 5 s ring counts down to the next lecture.
import { Play } from 'lucide-react';
import { useEffect } from 'react';
import type { Lecture } from '../../../shared/types';

export const UP_NEXT_MS = 5000; // keep in sync with --animate-countdown (index.css)

export function UpNext({ next, autoplay, onPlay, onCancel }: { next: Lecture; autoplay: boolean; onPlay: () => void; onCancel: () => void }) {
  useEffect(() => {
    if (!autoplay) return;
    const t = window.setTimeout(onPlay, UP_NEXT_MS);
    return () => window.clearTimeout(t);
  }, [autoplay, onPlay]);

  return (
    // Compact below sm: a phone-sized player is ~200 px tall and clips its children (overflow-hidden), so
    // the 140 px card at bottom-24 lost its top 31–35 px. Compact = 108 px at bottom-20, which clears the
    // bar's seek row (72 px from the bottom). Keep the two in step if the bar grows.
    <div
      role="dialog"
      aria-label="Up next"
      data-control="up-next"
      className="absolute bottom-20 right-3 z-30 w-80 max-w-[calc(100%-1.5rem)] animate-pop-in rounded-lg bg-player-panel p-3 text-player-ink shadow-e3 sm:bottom-24 sm:right-4 sm:max-w-[calc(100%-2rem)] sm:p-4"
    >
      <div className="flex items-center gap-3 sm:gap-4">
        <button type="button" onClick={onPlay} aria-label={`Play now: ${next.title}`} className="relative size-10 shrink-0 rounded-full hover:bg-player-hover sm:size-14">
          <svg viewBox="0 0 56 56" className="absolute inset-0 -rotate-90" aria-hidden="true">
            <circle cx="28" cy="28" r="25" fill="none" strokeWidth="3" className="stroke-player-track" />
            {autoplay && (
              <circle cx="28" cy="28" r="25" fill="none" strokeWidth="3" pathLength={100} strokeDasharray="100" strokeLinecap="round" className="animate-countdown stroke-player-accent" />
            )}
          </svg>
          <span className="absolute inset-0 flex items-center justify-center pl-0.5">
            <Play className="size-4 fill-current sm:size-5" strokeWidth={1.5} aria-hidden="true" />
          </span>
        </button>
        <div className="min-w-0">
          <p className="hidden text-xs font-medium uppercase tracking-[0.06em] text-player-ink-muted sm:block">Up next</p>
          <p className="line-clamp-2 text-sm font-medium sm:mt-1">{next.title}</p>
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2 sm:mt-4">
        <button type="button" onClick={onCancel} className="h-8 rounded-md px-3 text-sm text-player-ink-muted hover:bg-player-hover hover:text-player-ink">
          Cancel
        </button>
        <button type="button" onClick={onPlay} data-autofocus className="h-8 rounded-md bg-player-accent px-3 text-sm font-medium text-player-on-accent hover:opacity-90">
          Play now
        </button>
      </div>
    </div>
  );
}

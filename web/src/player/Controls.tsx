// Player chrome pieces on the always-dark player palette.
import { Check, RotateCcw, RotateCw, Volume1, Volume2, VolumeX } from 'lucide-react';
import { forwardRef, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useDismiss } from '../components/ui';
import { RATES } from '../lib/keys';

type PBProps = ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode; wideOnly?: boolean };

/** Icon button for the player bar (aria-label = label). `wideOnly` hides it below 640 px so the bar fits a
 *  phone. (A display utility must not be combined with `hidden` in one class list: Tailwind's order, not
 *  the string's, decides which wins — that is how the ±10 s buttons overflowed a 390 px bar.) */
export const PlayerButton = forwardRef<HTMLButtonElement, PBProps>(function PlayerButton({ label, children, className = '', wideOnly = false, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={`${wideOnly ? 'hidden sm:inline-flex' : 'inline-flex'} size-10 shrink-0 items-center justify-center rounded-md text-player-ink transition-[background-color,transform] duration-150 ease-out hover:bg-player-hover active:scale-95 ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
});

/** Circular arrow with "10" inside — back / forward 10 s. */
export function SkipTen({ dir }: { dir: -1 | 1 }) {
  const Icon = dir === -1 ? RotateCcw : RotateCw;
  return (
    <span className="relative inline-flex size-6 items-center justify-center" aria-hidden="true">
      <Icon className="size-6" strokeWidth={1.5} />
      <span className="absolute inset-0 flex items-center justify-center pt-px text-[8px] font-semibold tabular-nums">10</span>
    </span>
  );
}

/** Mute button + a vertical volume slider that appears above it on hover/focus (Netflix style). */
export function VolumeControl({ volume, muted, onChange }: { volume: number; muted: boolean; onChange: (patch: { volume?: number; muted?: boolean }) => void }) {
  const [open, setOpen] = useState(false);
  const track = useRef<HTMLDivElement>(null);
  const level = muted ? 0 : volume;
  const Icon = level === 0 ? VolumeX : level < 0.5 ? Volume1 : Volume2;
  const setFrom = (clientY: number): void => {
    const r = track.current?.getBoundingClientRect();
    if (!r || r.height === 0) return;
    const v = Math.max(0, Math.min(1, (r.bottom - clientY) / r.height));
    onChange({ volume: Math.round(v * 100) / 100, muted: v === 0 });
  };
  const down = (e: PointerEvent<HTMLDivElement>): void => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setFrom(e.clientY);
  };
  const move = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) setFrom(e.clientY);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>): void => {
    // ↑/↓ already change volume via the Watch key map; Home/End jump to the ends.
    if (e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    e.stopPropagation();
    onChange({ volume: e.key === 'Home' ? 0 : 1, muted: e.key === 'Home' });
  };

  return (
    <div className="relative" onPointerEnter={() => setOpen(true)} onPointerLeave={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOpen(false)}>
      <PlayerButton label={muted ? 'Unmute (M)' : 'Mute (M)'} onClick={() => onChange({ muted: !muted, volume: muted && volume === 0 ? 0.5 : volume })}>
        <Icon className="size-6" strokeWidth={1.5} />
      </PlayerButton>
      <div
        className={`absolute bottom-full left-1/2 mb-1 -translate-x-1/2 rounded-md bg-player-panel px-3 py-3 transition-[opacity,transform] duration-200 ease-out ${
          open ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-1 opacity-0'
        }`}
      >
        <div
          ref={track}
          role="slider"
          tabIndex={0}
          aria-label="Volume"
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(level * 100)}
          onPointerDown={down}
          onPointerMove={move}
          onKeyDown={key}
          className="relative h-24 w-1.5 cursor-pointer touch-none rounded-full bg-player-track"
        >
          <div className="absolute inset-x-0 bottom-0 rounded-full bg-player-ink" style={{ height: `${level * 100}%` }} />
          <div className="absolute left-1/2 size-3 -translate-x-1/2 translate-y-1/2 rounded-full bg-player-ink" style={{ bottom: `${level * 100}%` }} />
        </div>
      </div>
    </div>
  );
}

/** Height of the full menu: "Speed" label + one row per rate + divider + the autoplay row (px). */
const FULL_MENU_PX = 28 + RATES.length * 36 + 13 + 40 + 12;

/** Speed menu (0.5–2 in 0.25 steps; remembered) + the autoplay switch. */
export function SpeedMenu({
  rate,
  autoplay,
  onRate,
  onAutoplay,
  onOpenChange,
}: {
  rate: number;
  autoplay: boolean;
  onRate: (r: number) => void;
  onAutoplay: (on: boolean) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [open, setOpenState] = useState(false);
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const setOpen = (o: boolean): void => {
    // The player clips its children (rounded video corners), so the menu must fit between the button and
    // the player's top edge — on a phone-sized player that is ~140 px and the list scrolls.
    const btn = trigger.current?.getBoundingClientRect();
    const box = trigger.current?.closest('[data-player]')?.getBoundingClientRect();
    setMaxHeight(btn && box ? Math.max(120, btn.top - box.top - 16) : undefined);
    setOpenState(o);
    onOpenChange(o);
  };
  useDismiss(open, () => setOpen(false), [trigger, panel], trigger);
  // A short player (a phone: ~200 px tall, ~137 px above the bar) cannot show the list: it scrolled and
  // hid the current rate and the Autoplay switch. Compact = the rates as a 4-column grid (~130 px).
  const compact = maxHeight !== undefined && maxHeight < FULL_MENU_PX;
  // If the menu still scrolls, open it at the current rate — via the panel's own scrollTop, never
  // scrollIntoView (that also scrolls the page; see CourseContent).
  useLayoutEffect(() => {
    const p = panel.current;
    const item = p?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]');
    if (!open || !p || !item) return;
    const bottom = item.offsetTop + item.offsetHeight;
    if (bottom > p.scrollTop + p.clientHeight) p.scrollTop = bottom - p.clientHeight + 6;
  }, [open]);
  return (
    <div className="relative">
      <button
        ref={trigger}
        type="button"
        aria-label={`Playback speed ${rate}×`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen(!open)}
        className="inline-flex h-10 min-w-12 items-center justify-center rounded-md px-2 text-sm font-semibold tabular-nums text-player-ink hover:bg-player-hover"
      >
        {rate}×
      </button>
      {open && (
        <div
          ref={panel}
          role="menu"
          aria-label="Playback speed"
          style={{ maxHeight }}
          className="quiet-scroll absolute bottom-full right-0 mb-2 w-56 animate-pop-in overflow-y-auto overscroll-contain rounded-lg bg-player-panel p-1.5 text-player-ink shadow-e3"
        >
          {compact ? (
            <div className="grid grid-cols-4 gap-1">
              {RATES.map((r) => (
                <button
                  key={r}
                  type="button"
                  role="menuitemradio"
                  aria-checked={r === rate}
                  aria-label={r === 1 ? 'Normal speed' : `${r}× speed`}
                  onClick={() => {
                    onRate(r);
                    setOpen(false);
                  }}
                  className={`h-8 rounded-md text-sm tabular-nums ${r === rate ? 'bg-player-ink font-semibold text-player' : 'hover:bg-player-hover'}`}
                >
                  {r}×
                </button>
              ))}
            </div>
          ) : (
            <>
              <p className="px-3 pb-1 pt-2 text-xs font-medium text-player-ink-muted">Speed</p>
              {RATES.map((r) => (
                <button
                  key={r}
                  type="button"
                  role="menuitemradio"
                  aria-checked={r === rate}
                  onClick={() => {
                    onRate(r);
                    setOpen(false);
                  }}
                  className="flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-sm tabular-nums hover:bg-player-hover"
                >
                  <span className="w-4">{r === rate && <Check className="size-4" strokeWidth={2} aria-hidden="true" />}</span>
                  {r === 1 ? 'Normal' : `${r}×`}
                </button>
              ))}
            </>
          )}
          <div className="mx-3 my-1.5 border-t border-player-track" />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={autoplay}
            onClick={() => onAutoplay(!autoplay)}
            className={`flex w-full items-center justify-between gap-3 rounded-md px-3 text-left text-sm hover:bg-player-hover ${compact ? 'h-9' : 'h-10'}`}
          >
            Autoplay next lecture
            <span className={`relative h-5 w-9 shrink-0 rounded-full ${autoplay ? 'bg-player-accent' : 'bg-player-track'}`} aria-hidden="true">
              <span className={`absolute top-0.5 size-4 rounded-full bg-player-ink transition-transform duration-150 ease-out ${autoplay ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

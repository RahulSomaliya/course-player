// Seek bar: buffered range, played range, hover grows the bar + time tooltip, drag to scrub.
// Keyboard: it is a focusable role="slider"; ←/→ come from the Watch key map (±10 s), Home/End here.
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { formatClock } from '../lib/format';

interface Props {
  time: number;
  duration: number;
  bufferedEnd: number;
  /** final=false while dragging (the player throttles those), true on release */
  onSeek: (seconds: number, final: boolean) => void;
  onScrubbing: (scrubbing: boolean) => void;
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

export function SeekBar({ time, duration, bufferedEnd, onSeek, onScrubbing }: Props) {
  const bar = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const known = duration > 0;
  const fractionAt = (clientX: number): number => {
    const r = bar.current?.getBoundingClientRect();
    return r && r.width > 0 ? clamp01((clientX - r.left) / r.width) : 0;
  };
  const played = drag ?? (known ? clamp01(time / duration) : 0);
  const buffered = known ? clamp01(bufferedEnd / duration) : 0;
  const tip = drag ?? hover;

  const down = (e: PointerEvent<HTMLDivElement>): void => {
    if (!known || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const f = fractionAt(e.clientX);
    setDrag(f);
    onScrubbing(true);
    onSeek(f * duration, false);
  };
  const move = (e: PointerEvent<HTMLDivElement>): void => {
    const f = fractionAt(e.clientX);
    setHover(f);
    if (drag !== null) {
      setDrag(f);
      onSeek(f * duration, false);
    }
  };
  const up = (e: PointerEvent<HTMLDivElement>): void => {
    if (drag === null) return;
    const f = fractionAt(e.clientX);
    setDrag(null);
    onScrubbing(false);
    onSeek(f * duration, true);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      e.stopPropagation();
      onSeek(e.key === 'Home' ? 0 : Math.max(0, duration - 0.5), true);
    }
  };

  return (
    <div
      ref={bar}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(time)}
      aria-valuetext={`${formatClock(time)} of ${formatClock(duration)}`}
      data-control="seek"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onPointerLeave={() => setHover(null)}
      onKeyDown={key}
      className="group/seek relative flex h-5 cursor-pointer touch-none items-center rounded-full outline-offset-4"
    >
      <div
        className={`relative h-1.5 w-full origin-center overflow-hidden rounded-full bg-player-track transition-transform duration-150 ease-out group-hover/seek:scale-y-100 ${
          drag !== null ? 'scale-y-100' : 'scale-y-[0.67]'
        }`}
      >
        <div className="absolute inset-y-0 left-0 bg-player-buffer" style={{ width: `${buffered * 100}%` }} />
        <div className="absolute inset-y-0 left-0 bg-player-accent" style={{ width: `${played * 100}%` }} />
      </div>
      <div
        className={`pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-player-accent transition-transform duration-150 ease-out group-hover/seek:scale-100 group-focus-visible/seek:scale-100 ${
          drag !== null ? 'scale-100' : 'scale-0'
        }`}
        style={{ left: `${played * 100}%` }}
      />
      {tip !== null && known && (
        <div
          className="pointer-events-none absolute bottom-6 -translate-x-1/2 rounded-md bg-player-panel px-2 py-1 text-xs font-medium tabular-nums text-player-ink"
          style={{ left: `clamp(1.5rem, ${tip * 100}%, calc(100% - 1.5rem))` }}
        >
          {formatClock(tip * duration)}
        </div>
      )}
    </div>
  );
}

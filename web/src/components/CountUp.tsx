// A number that counts up from 0 on the first paint of home (≤ 700 ms, ease-out), then simply shows
// its value. It starts visible ("0m"), so a screenshot mid-count still reads as a number, and the
// final value is what assistive tech reads (the animated copy is aria-hidden). `play` holds it at 0
// until its row is in view (lib/motion.ts useSeenOnce) — counting below the fold is counting unseen.
import { useEffect, useState } from 'react';
import { prefersReducedMotion } from '../lib/motion';

const DURATION_MS = 700;
const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;

export function CountUp({ value, format, animate, play = true }: { value: number; format: (n: number) => string; animate: boolean; play?: boolean }) {
  // Only the value present at mount animates; later changes (the running study timer) just update.
  const [from] = useState(() => (animate && !prefersReducedMotion() ? 0 : null));
  const [shown, setShown] = useState<number | null>(from);

  useEffect(() => {
    if (from === null || !play) return;
    let frame = 0;
    const start = performance.now();
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / DURATION_MS);
      if (t >= 1) {
        setShown(null);
        return;
      }
      setShown(value * easeOutCubic(t));
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
    // Deliberately not on `value`: it counts once, towards the value when it starts (the running timer
    // changes Today every 15 s while she studies — re-counting from 0 each time would be noise).
  }, [from, play]);

  if (shown === null) return <>{format(value)}</>;
  return (
    <>
      <span aria-hidden="true">{format(shown)}</span>
      <span className="sr-only">{format(value)}</span>
    </>
  );
}

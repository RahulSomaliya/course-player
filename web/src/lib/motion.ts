// Motion helpers (docs/design.md "Motion"). Every moment is off under prefers-reduced-motion: CSS
// handles keyframes/transitions (index.css), and JS-driven motion (View Transitions, count-up) asks here.
import { useEffect, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { navigate, navigateNow, type Route } from './router';

export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

type ViewTransitionDocument = Document & { startViewTransition?: (update: () => void) => unknown };

/**
 * Home → Watch: the Continue thumbnail morphs into the player (both carry `view-transition-name:
 * lecture-media`, see ContinueHero + Player). Only the Continue links call this — any other link into
 * Watch is a different lecture, and morphing a picture of one lecture into another would lie.
 * Feature-detected; reduced motion navigates instantly.
 */
export function navigateWithMorph(route: Route): void {
  const doc = document as ViewTransitionDocument;
  if (typeof doc.startViewTransition !== 'function' || prefersReducedMotion()) {
    navigate(route);
    return;
  }
  // The update callback must leave the NEW screen in the DOM before it returns (the browser snapshots
  // it then): flushSync renders the route change synchronously, see navigateNow.
  doc.startViewTransition(() => flushSync(() => navigateNow(route)));
}

/**
 * True once `ref`'s element has been at least `threshold` in view — first-paint motion below the fold
 * (home's count-up and bar rise) plays when she gets there. On a phone, and on the laptop whenever
 * "From Rahul" is unread, that row starts far below the fold: started at mount it finished unseen
 * (2026-10-01 review). True at once when not `enabled` or without IntersectionObserver (jsdom).
 */
export function useSeenOnce(ref: RefObject<Element | null>, enabled: boolean, threshold = 0.4): boolean {
  const [seen, setSeen] = useState(() => !enabled || typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (seen || el === null) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting && e.intersectionRatio >= threshold)) return;
        io.disconnect();
        setSeen(true);
      },
      { threshold },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, seen, threshold]);
  return seen;
}

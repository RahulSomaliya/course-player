// Height animation without measuring: a one-row grid whose track goes 0fr ↔ 1fr (~220 ms). Children
// mount only while open (and while it closes); `entering` tells them it opened just now, so rows can
// rise in with a short stagger — never on first render (an already-open section must not animate).
// The panel clips while it animates: focus rings inside use the inset rule (.inset-focus, index.css).
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { prefersReducedMotion } from '../lib/motion';

interface Props {
  open: boolean;
  children: (entering: boolean) => ReactNode;
  id?: string;
  className?: string;
  /** after the close animation, once the children are gone */
  onExited?: () => void;
  /** close with --ease-in (an exit: slow start, the height goes mostly at the end) instead of ease-out.
   *  FromRahul needs it: its card fades first, so the fold must not clip text it can still see. */
  easeInOnClose?: boolean;
}

/** a missed transitionend (tab hidden mid-animation) must not leave the children mounted */
const CLOSE_FALLBACK_MS = 400;

export function Collapse({ open, children, id, className = '', onExited, easeInOnClose = false }: Props) {
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);
  const [entering, setEntering] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const exited = useRef(onExited);
  exited.current = onExited;

  useLayoutEffect(() => {
    if (open) {
      if (!mounted) {
        setMounted(true); // render at 0fr first; this effect runs again and expands
        return;
      }
      if (!expanded) {
        void box.current?.offsetHeight; // commit the 0fr style so the change to 1fr transitions
        setEntering(!prefersReducedMotion());
        setExpanded(true);
      }
      return;
    }
    if (expanded) {
      setExpanded(false);
      setEntering(false);
    }
  }, [open, mounted, expanded]);

  // Closed: unmount the children when the track has collapsed.
  useLayoutEffect(() => {
    if (open || expanded || !mounted) return;
    const finish = (): void => {
      setMounted(false);
      exited.current?.();
    };
    if (prefersReducedMotion()) {
      finish();
      return;
    }
    const el = box.current;
    const t = window.setTimeout(finish, CLOSE_FALLBACK_MS);
    const onEnd = (e: TransitionEvent): void => {
      if (e.target === el && e.propertyName === 'grid-template-rows') finish();
    };
    el?.addEventListener('transitionend', onEnd);
    return () => {
      window.clearTimeout(t);
      el?.removeEventListener('transitionend', onEnd);
    };
  }, [open, expanded, mounted]);

  return (
    <div
      ref={box}
      id={id}
      data-open={expanded ? 'true' : 'false'}
      style={easeInOnClose && !expanded ? { transitionTimingFunction: 'var(--ease-in)' } : undefined}
      className={`grid transition-[grid-template-rows] duration-[220ms] ease-out ${expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'} ${className}`}
    >
      <div className="inset-focus min-h-0 overflow-hidden">{mounted && children(entering)}</div>
    </div>
  );
}

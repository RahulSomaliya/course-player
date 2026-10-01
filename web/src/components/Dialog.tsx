// Modal dialog: scrim, centred card, Escape closes, focus moves in and is restored on close.
// Used sparingly (sign-off card, shortcut sheet, in-app pdf) — everything else is inline.
// Motion: `enter="rise"` lifts the card in (the sign-off card); `leaving` plays the exit (scrim fades,
// card drops away, 180 ms) — the owner unmounts it when that is done.
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  labelledBy: string;
  children: ReactNode;
  /** tailwind width/height classes for the card */
  className?: string;
  /** the player's sheet sits on the always-dark player palette */
  tone?: 'app' | 'player';
  enter?: 'pop' | 'rise';
  leaving?: boolean;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({ open, onClose, labelledBy, children, className = 'max-w-md', tone = 'app', enter = 'pop', leaving = false }: DialogProps) {
  const card = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = card.current?.querySelector<HTMLElement>('[data-autofocus]') ?? card.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? card.current)?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !card.current) return;
      const items = Array.from(card.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const firstItem = items[0] as HTMLElement;
      const lastItem = items[items.length - 1] as HTMLElement;
      if (e.shiftKey && document.activeElement === firstItem) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && document.activeElement === lastItem) {
        e.preventDefault();
        firstItem.focus();
      }
    };
    // capture: the Watch page's player keys must not see keys typed into a dialog
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      before?.focus();
    };
  }, [open]);

  if (!open) return null;
  const surface = tone === 'player' ? 'bg-player-panel text-player-ink' : 'bg-raised text-ink border border-line';
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" data-dialog="open">
      <div className={`absolute inset-0 bg-scrim ${leaving ? 'animate-scrim-out' : 'animate-fade-in'}`} onClick={onClose} aria-hidden="true" />
      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={`relative w-full rounded-lg shadow-e3 outline-none ${leaving ? 'animate-leave' : enter === 'rise' ? 'animate-rise' : 'animate-pop-in'} ${surface} ${className}`}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

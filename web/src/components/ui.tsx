// Primitives shared by every screen. Token classes only (docs/design.md) — no raw colours here.
import { forwardRef, useEffect, useRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode, type RefObject } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-on-accent shadow-e1 hover:bg-accent-hover active:shadow-none',
  secondary: 'border border-line bg-surface text-ink hover:bg-fill',
  ghost: 'text-ink-muted hover:bg-fill hover:text-ink',
};

const SIZES: Record<Size, string> = {
  sm: 'h-8 gap-1.5 px-3 text-sm',
  md: 'h-10 gap-2 px-4 text-sm',
  lg: 'h-12 gap-2 px-6 text-base',
};

const BASE =
  'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-md font-medium ' +
  'transition-[background-color,box-shadow,transform] duration-150 ease-out active:translate-y-px ' +
  'disabled:pointer-events-none disabled:opacity-50';

export function buttonClass(variant: Variant = 'secondary', size: Size = 'md', extra = ''): string {
  return `${BASE} ${VARIANTS[variant]} ${SIZES[size]} ${extra}`;
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', className = '', type = 'button', ...rest },
  ref,
) {
  return <button ref={ref} type={type} className={buttonClass(variant, size, className)} {...rest} />;
});

type LinkButtonProps = AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: Variant; size?: Size };

export function LinkButton({ variant = 'secondary', size = 'md', className = '', ...rest }: LinkButtonProps) {
  return <a className={buttonClass(variant, size, className)} {...rest} />;
}

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: 'sm' | 'md'; desktopOnly?: boolean };

/** Square ghost button; `label` becomes the aria-label (every icon button needs one). */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = 'md', className = '', type = 'button', desktopOnly = false, children, ...rest },
  ref,
) {
  const box = size === 'sm' ? 'size-8' : 'size-10';
  // never pass `hidden` via className: it would fight the display utility below (see PlayerButton)
  const display = desktopOnly ? 'hidden lg:inline-flex' : 'inline-flex';
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={`${box} ${display} shrink-0 items-center justify-center rounded-md text-ink-muted transition-[background-color] duration-150 ease-out hover:bg-fill hover:text-ink disabled:pointer-events-none disabled:opacity-40 ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
});

/** Thin progress line: 3 px track, accent value. Never animated (screenshots catch transitions). */
export function ProgressLine({ value, className = '', label }: { value: number; className?: string; label?: string }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div
      className={`h-[3px] overflow-hidden rounded-full bg-fill-strong ${className}`}
      role={label ? 'progressbar' : undefined}
      aria-label={label}
      aria-valuenow={label ? Math.round(pct) : undefined}
      aria-valuemin={label ? 0 : undefined}
      aria-valuemax={label ? 100 : undefined}
    >
      <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** done: accent disc + tick · partly watched: accent arc · not started: hairline circle. */
export function LectureStatus({ done, fraction, className = 'size-[18px]' }: { done: boolean; fraction: number; className?: string }) {
  if (done) {
    return (
      <svg viewBox="0 0 18 18" className={`shrink-0 ${className}`} aria-hidden="true">
        <circle cx="9" cy="9" r="9" className="fill-accent" />
        <path d="M5.2 9.3l2.4 2.4 5-5.1" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="stroke-on-accent" />
      </svg>
    );
  }
  const r = 7.25;
  const c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, fraction));
  return (
    <svg viewBox="0 0 18 18" className={`shrink-0 -rotate-90 ${className}`} aria-hidden="true">
      <circle cx="9" cy="9" r={r} fill="none" strokeWidth="1.5" className="stroke-line" />
      {f > 0.02 && (
        <circle cx="9" cy="9" r={r} fill="none" strokeWidth="2" strokeLinecap="round" strokeDasharray={`${f * c} ${c}`} className="stroke-accent" />
      )}
    </svg>
  );
}

export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'xl' }) {
  const box = size === 'xl' ? 'size-28 text-5xl rounded-lg' : size === 'md' ? 'size-8 text-sm rounded-full' : 'size-6 text-xs rounded-full';
  return (
    <span aria-hidden="true" className={`${box} inline-flex shrink-0 select-none items-center justify-center bg-fill-strong font-semibold text-ink`}>
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-breathe rounded-md bg-fill ${className}`} />;
}

/** Closes a popover on outside pointerdown or Escape (focus returns to the trigger). */
export function useDismiss(open: boolean, close: () => void, refs: RefObject<HTMLElement | null>[], trigger?: RefObject<HTMLElement | null>): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node;
      if (refs.some((r) => r.current?.contains(t))) return;
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      closeRef.current();
      trigger?.current?.focus();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
    // `refs`/`trigger` are stable ref objects, so `open` is the only real dependency.
  }, [open]);
}

export function Overline({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <p className={`text-xs font-medium uppercase tracking-[0.06em] text-ink-muted ${className}`}>{children}</p>;
}

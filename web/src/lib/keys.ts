// Player keyboard map (spec "The player"). Pure: Watch decides what each action does per lecture kind.

export type PlayerAction =
  | { type: 'togglePlay' }
  | { type: 'seekBy'; seconds: number }
  | { type: 'volumeBy'; delta: number }
  | { type: 'toggleMute' }
  | { type: 'fullscreen' }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'rateStep'; dir: 1 | -1 }
  | { type: 'seekToFraction'; fraction: number }
  | { type: 'theatre' }
  | { type: 'help' };

export interface KeyLike {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

export function keyToAction(e: KeyLike): PlayerAction | null {
  // Cmd/Ctrl/Alt combos belong to the browser and macOS (Cmd+F, Ctrl+←…).
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  const { key } = e;
  if (e.shiftKey && (key === 'N' || key === 'n')) return { type: 'next' };
  if (e.shiftKey && (key === 'P' || key === 'p')) return { type: 'prev' };
  if (key === '<') return { type: 'rateStep', dir: -1 };
  if (key === '>') return { type: 'rateStep', dir: 1 };
  if (key === '?') return { type: 'help' };
  if (/^[0-9]$/.test(key)) return { type: 'seekToFraction', fraction: Number(key) / 10 };
  switch (key.length === 1 ? key.toLowerCase() : key) {
    case ' ':
    case 'k':
      return { type: 'togglePlay' };
    case 'ArrowLeft':
    case 'j':
      return { type: 'seekBy', seconds: -10 };
    case 'ArrowRight':
    case 'l':
      return { type: 'seekBy', seconds: 10 };
    case 'ArrowUp':
      return { type: 'volumeBy', delta: 0.1 };
    case 'ArrowDown':
      return { type: 'volumeBy', delta: -0.1 };
    case 'm':
      return { type: 'toggleMute' };
    case 'f':
      return { type: 'fullscreen' };
    case 't':
      return { type: 'theatre' };
    default:
      return null;
  }
}

const NON_TEXT_INPUTS = new Set(['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'image']);

/** Player keys are ignored while the learner types (the JS Journey link, the wrap-up note…). */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.closest('[contenteditable]:not([contenteditable="false"])') !== null) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(target.type);
  return false;
}

export const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export function stepRate(rate: number, dir: 1 | -1): number {
  if (dir === 1) return RATES.find((r) => r > rate + 1e-9) ?? RATES[RATES.length - 1]!;
  return [...RATES].reverse().find((r) => r < rate - 1e-9) ?? RATES[0];
}

/** The shortcut sheet (`?`) — kept next to the map so the two never drift. */
export const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ['Space', 'K'], label: 'Play / pause' },
  { keys: ['←', 'J'], label: 'Back 10 seconds' },
  { keys: ['→', 'L'], label: 'Forward 10 seconds' },
  { keys: ['↑', '↓'], label: 'Volume' },
  { keys: ['M'], label: 'Mute' },
  { keys: ['F'], label: 'Fullscreen' },
  { keys: ['<', '>'], label: 'Slower / faster' },
  { keys: ['0–9'], label: 'Jump to 0–90 %' },
  { keys: ['⇧N', '⇧P'], label: 'Next / previous lecture' },
  { keys: ['T'], label: 'Theatre mode' },
  { keys: ['?'], label: 'This sheet' },
];

// localStorage that never throws: private windows and full quotas throw on access, and the app must
// keep working in memory (spec "Progress & storage"). Every read is validated — a hand-edited or
// half-written value is treated as missing, never trusted.

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** window.localStorage, or null when even touching the property throws (Safari private mode, policies). */
export function browserStore(): KeyValueStore | null {
  try {
    return window.localStorage;
  } catch (err) {
    console.warn('[storage] localStorage unavailable — keeping progress in memory only', err);
    return null;
  }
}

export function readJson<T>(store: KeyValueStore | null, key: string, isValid: (x: unknown) => x is T): T | null {
  if (store === null) return null;
  try {
    const raw = store.getItem(key);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isValid(parsed) ? parsed : null;
  } catch (err) {
    console.warn(`[storage] could not read ${key}`, err);
    return null;
  }
}

export function writeJson(store: KeyValueStore | null, key: string, value: unknown): boolean {
  if (store === null) return false;
  try {
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.warn(`[storage] could not write ${key}`, err);
    return false;
  }
}

export function readString(store: KeyValueStore | null, key: string): string | null {
  if (store === null) return null;
  try {
    return store.getItem(key);
  } catch (err) {
    console.warn(`[storage] could not read ${key}`, err);
    return null;
  }
}

export function writeString(store: KeyValueStore | null, key: string, value: string | null): void {
  if (store === null) return;
  try {
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch (err) {
    console.warn(`[storage] could not write ${key}`, err);
  }
}

export interface Saver {
  /** a change happened; save after `delayMs` of quiet, or at the latest `maxWaitMs` after the first change */
  schedule(): void;
  /** save now if anything is pending */
  flush(): void;
  cancel(): void;
}

/**
 * Debounce with a max wait. A plain 2 s debounce never fires while a video plays — the player saves its
 * position every 5 s — so the SSD copy would lag a whole viewing session behind.
 */
export function createSaver(save: () => void, opts: { delayMs: number; maxWaitMs: number }): Saver {
  let quiet: ReturnType<typeof setTimeout> | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  const clear = (): void => {
    if (quiet !== null) clearTimeout(quiet);
    if (deadline !== null) clearTimeout(deadline);
    quiet = null;
    deadline = null;
  };
  const fire = (): void => {
    clear();
    save();
  };
  return {
    schedule() {
      if (quiet !== null) clearTimeout(quiet);
      quiet = setTimeout(fire, opts.delayMs);
      if (deadline === null) deadline = setTimeout(fire, opts.maxWaitMs);
    },
    flush() {
      if (quiet !== null || deadline !== null) fire();
    },
    cancel: clear,
  };
}

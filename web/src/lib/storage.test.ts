import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSaver, readJson, writeJson, type KeyValueStore } from './storage';

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const throwing: KeyValueStore = {
  getItem: () => {
    throw new Error('SecurityError: private window');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
  removeItem: () => {
    throw new Error('SecurityError');
  },
};

describe('readJson / writeJson', () => {
  it('round-trips through a store', () => {
    const s = memoryStore();
    expect(writeJson(s, 'a', { x: 1 })).toBe(true);
    expect(readJson(s, 'a', (x): x is { x: number } => typeof x === 'object' && x !== null)).toEqual({ x: 1 });
  });
  it('returns null for missing, unparsable or invalid values', () => {
    const s = memoryStore();
    s.data.set('bad', '{nope');
    s.data.set('wrong', '"str"');
    const isObj = (x: unknown): x is object => typeof x === 'object' && x !== null;
    expect(readJson(s, 'missing', isObj)).toBeNull();
    expect(readJson(s, 'bad', isObj)).toBeNull();
    expect(readJson(s, 'wrong', isObj)).toBeNull();
  });
  it('a throwing store (private window) never breaks the app', () => {
    expect(readJson(throwing, 'a', (_x): _x is unknown => true)).toBeNull();
    expect(writeJson(throwing, 'a', 1)).toBe(false);
    expect(writeJson(null, 'a', 1)).toBe(false);
  });
});

describe('createSaver (debounced PUT with a max wait)', () => {
  afterEach(() => vi.useRealTimers());

  it('saves 2 s after the last change', () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const s = createSaver(save, { delayMs: 2000, maxWaitMs: 30_000 });
    s.schedule();
    vi.advanceTimersByTime(1500);
    s.schedule();
    vi.advanceTimersByTime(1500);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    expect(save).toHaveBeenCalledTimes(1);
  });
  it('still saves during continuous changes (the 1 s study ticker) once maxWait passes', () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const s = createSaver(save, { delayMs: 2000, maxWaitMs: 10_000 });
    for (let i = 0; i < 12; i++) {
      s.schedule();
      vi.advanceTimersByTime(1000);
    }
    expect(save).toHaveBeenCalledTimes(1);
  });
  it('flush saves now only when something is pending', () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const s = createSaver(save, { delayMs: 2000, maxWaitMs: 30_000 });
    s.flush();
    expect(save).not.toHaveBeenCalled();
    s.schedule();
    s.flush();
    expect(save).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(save).toHaveBeenCalledTimes(1);
  });
});

// @vitest-environment jsdom
// The once-a-day goal moment (spec v4 "Chart + daily goal"): the first time today reads as goal-met on
// home, the Today ✓ draws in and the today bar rises — once per date, never again after a reload or a
// return from Watch.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KeyValueStore } from './storage';
import { goalMomentKey, useGoalMoment } from './goal-moment';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function memoryStore(init: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

const KEY = goalMomentKey('react-2023', 'mansi');
const MON = '2026-10-12';
const TUE = '2026-10-13';

let root: Root | null = null;
let seen: boolean[] = [];
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  seen = [];
  document.body.innerHTML = '';
});

function Probe({ met, today, store }: { met: boolean; today: string; store: KeyValueStore | null }) {
  seen.push(useGoalMoment(met, today, KEY, store));
  return null;
}
function mount(props: { met: boolean; today: string; store: KeyValueStore | null }): (next: { met: boolean; today: string }) => void {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(Probe, props)));
  return (next) => act(() => root?.render(createElement(Probe, { ...props, ...next })));
}
const last = (): boolean | undefined => seen[seen.length - 1];

describe('useGoalMoment (once per day, remembered per date)', () => {
  it('the key is per course + profile, like every other browser key', () => {
    expect(KEY).toBe('cp:react-2023:mansi:goal-moment');
  });

  it('crossing the goal while home is open → the moment, and the date is remembered', () => {
    const store = memoryStore();
    const rerender = mount({ met: false, today: MON, store });
    expect(last()).toBe(false);
    rerender({ met: true, today: MON });
    expect(last()).toBe(true);
    expect(store.data.get(KEY)).toBe(MON);
    rerender({ met: true, today: MON }); // the running timer ticks on: it stays, nothing replays
    expect(last()).toBe(true);
  });

  it('arriving on home already met (she crossed it on Watch) and not yet remembered → the moment', () => {
    const store = memoryStore();
    mount({ met: true, today: MON, store });
    expect(seen[0]).toBe(true); // decided on the first render, so the ✓ never flashes in drawn first
    expect(store.data.get(KEY)).toBe(MON);
  });

  it('never again that day: a reload / a return from Watch shows it met, without the moment', () => {
    const store = memoryStore({ [KEY]: MON });
    const rerender = mount({ met: true, today: MON, store });
    expect(seen.every((m) => !m)).toBe(true);
    rerender({ met: true, today: MON });
    expect(last()).toBe(false);
  });

  it('a new day plays it again (the date, not a flag, is remembered)', () => {
    const store = memoryStore({ [KEY]: MON });
    mount({ met: true, today: TUE, store });
    expect(last()).toBe(true);
    expect(store.data.get(KEY)).toBe(TUE);
  });

  it('not met → no moment, nothing written', () => {
    const store = memoryStore();
    mount({ met: false, today: MON, store });
    expect(last()).toBe(false);
    expect(store.data.has(KEY)).toBe(false);
  });

  it('storage that throws (private window) or is missing: the moment still plays, nothing breaks', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => undefined,
    };
    mount({ met: true, today: MON, store: broken });
    expect(last()).toBe(true);
    act(() => root?.unmount());
    root = null;
    mount({ met: true, today: MON, store: null });
    expect(last()).toBe(true);
    warn.mockRestore();
  });
});

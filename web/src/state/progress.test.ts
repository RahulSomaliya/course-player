import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProgressState } from '../../../shared/types';
import { emptyProgress, withLast, withPos } from '../lib/progress';
import type { KeyValueStore } from '../lib/storage';
import { KEEPALIVE_LIMIT, ProgressStore, progressKey } from './progress';

function memoryStore(init: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

const KEY = progressKey('react-2023', 'mansi');
const state = (updatedAt: number): ProgressState => ({ ...emptyProgress(), updatedAt, lastLectureId: `at-${updatedAt}` });

function make(opts: { local?: ProgressState; remote?: ProgressState | null; storage?: KeyValueStore | null }) {
  const storage = opts.storage === undefined ? memoryStore(opts.local ? { [KEY]: JSON.stringify(opts.local) } : {}) : opts.storage;
  const put = vi.fn(async (_body: string, _o: { keepalive: boolean }) => undefined);
  const get = vi.fn(async () => (opts.remote === undefined ? null : opts.remote) as unknown);
  let now = 1_000_000;
  const store = new ProgressStore({ courseId: 'react-2023', profile: 'mansi', storage, api: { get, put }, now: () => ++now });
  return { store, storage, put, get };
}

afterEach(() => vi.useRealTimers());

describe('ProgressStore.hydrate (boot: adopt whichever copy has the larger updatedAt)', () => {
  it('adopts the SSD copy when it is newer, and stores it locally', async () => {
    const { store, storage } = make({ local: state(100), remote: state(200) });
    await store.hydrate();
    expect(store.get().lastLectureId).toBe('at-200');
    expect(JSON.parse((storage as ReturnType<typeof memoryStore>).data.get(KEY) as string).updatedAt).toBe(200);
  });
  it('keeps the local copy when it is newer and pushes it to the SSD', async () => {
    const { store, put } = make({ local: state(300), remote: state(200) });
    await store.hydrate();
    expect(store.get().lastLectureId).toBe('at-300');
    expect(put).toHaveBeenCalledTimes(1);
    expect(JSON.parse(put.mock.calls[0]?.[0] as string).updatedAt).toBe(300);
  });
  it('a cleared browser recovers everything from the SSD', async () => {
    const { store } = make({ remote: state(200) });
    await store.hydrate();
    expect(store.get().lastLectureId).toBe('at-200');
  });
  it('ignores a corrupted SSD copy', async () => {
    // a corrupted file on the SSD: deliberately not a ProgressState, which the store must reject at runtime
    const { store } = make({ local: state(100), remote: { nope: true } as unknown as ProgressState });
    await store.hydrate();
    expect(store.get().lastLectureId).toBe('at-100');
  });
  it('an unreachable server keeps the local copy (no throw)', async () => {
    const { store, get } = make({ local: state(100) });
    get.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await store.hydrate();
    expect(store.get().lastLectureId).toBe('at-100');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it('a change made while the SSD copy loads is not lost', async () => {
    const { store, get } = make({ local: state(100), remote: state(200) });
    let release: () => void = () => undefined;
    get.mockImplementationOnce(() => new Promise((r) => (release = () => r(state(200)))));
    const pending = store.hydrate();
    store.update((s, now) => withPos(s, 'x.mp4', 30, now));
    release();
    await pending;
    expect(store.get().lectures['x.mp4']?.pos).toBe(30);
    // ...and it lands on the SSD copy's data, not instead of it
    expect(store.get().lastLectureId).toBe('at-200');
  });
  it('StrictMode mounts twice: a second hydrate() reuses the first GET', async () => {
    const { store, get } = make({ local: state(100), remote: state(200) });
    await Promise.all([store.hydrate(), store.hydrate()]);
    expect(get).toHaveBeenCalledTimes(1);
  });
});

// Review finding (2026-10-01): a browser with no progress copy (cleared site data, a second browser)
// opened at #/watch/<id> overwrote the newer SSD copy. WatchScreen's mount effect stamps `withLast`
// BEFORE ProfileApp's effect calls hydrate() (React runs child passive effects first), so the empty
// local copy looked newer than the SSD copy; LWW kept it and PUT it over the SSD copy.
describe('ProgressStore: changes made before the SSD copy is read', () => {
  const SSD_SAVED_AT = Date.parse('2026-09-30T18:00:00Z');
  const OPENED_AT = Date.parse('2026-10-01T09:00:00Z');
  /** The SSD copy another Mac wrote: two lectures done, last on 02/01. */
  const ssdCopy = (): ProgressState => ({
    ...emptyProgress(SSD_SAVED_AT),
    lastLectureId: '02 Fundamentals/01 Part intro.mp4',
    lectures: {
      '01 Welcome/01 Intro.mp4': { pos: 590, done: true, doneAt: SSD_SAVED_AT - 3_600_000 },
      '01 Welcome/02 Setup.mp4': { pos: 600, done: true, doneAt: SSD_SAVED_AT - 1_800_000 },
    },
    days: { '2026-09-30': 5400 },
  });
  function slowStore(storage: KeyValueStore = memoryStore()) {
    let release: (v: unknown) => void = () => undefined;
    const get = vi.fn(() => new Promise<unknown>((r) => (release = r)));
    const put = vi.fn(async (_body: string, _o: { keepalive: boolean }) => undefined);
    const store = new ProgressStore({ courseId: 'react-2023', profile: 'mansi', storage, api: { get, put }, now: () => OPENED_AT });
    return { store, get, put, storage, release: (v: unknown) => release(v) };
  }

  it('a cleared browser opened at #/watch/<id> keeps the SSD progress (locally and on the SSD)', async () => {
    const storage = memoryStore();
    const { store, put, release } = slowStore(storage);
    store.update((s, now) => withLast(s, '01 Welcome/03 Roadmap.mp4', now)); // Watch mounts first
    const pending = store.hydrate();
    release(ssdCopy());
    await pending;

    expect(store.get().lectures['01 Welcome/02 Setup.mp4']?.done).toBe(true);
    expect(store.get().days['2026-09-30']).toBe(5400);
    expect(store.get().lastLectureId).toBe('01 Welcome/03 Roadmap.mp4'); // the early change is replayed on top
    expect(store.get().updatedAt).toBe(OPENED_AT);
    expect(JSON.parse(storage.data.get(KEY) as string).lectures['01 Welcome/02 Setup.mp4'].done).toBe(true);
    expect(put).toHaveBeenCalledTimes(1);
    for (const [body] of put.mock.calls) expect((JSON.parse(body) as ProgressState).lectures['01 Welcome/02 Setup.mp4']?.done).toBe(true);
  });

  it('nothing leaves memory before the SSD copy is read (no PUT, no localStorage write)', () => {
    const storage = memoryStore();
    const { store, put } = slowStore(storage);
    void store.hydrate();
    store.update((s, now) => withPos(s, 'a.mp4', 42, now));
    expect(store.get().lectures['a.mp4']?.pos).toBe(42); // the UI still sees it
    store.flushOnHide(); // tab closed while the GET is in flight
    expect(put).not.toHaveBeenCalled();
    // a stamped copy in localStorage would beat the SSD copy on the next boot
    expect(storage.data.has(KEY)).toBe(false);
  });

  it('an unreachable SSD copy keeps the early changes and saves them later', async () => {
    vi.useFakeTimers();
    const storage = memoryStore();
    const { store, put, get } = slowStore(storage);
    get.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    store.update((s, now) => withPos(s, 'a.mp4', 42, now));
    await store.hydrate();
    expect(JSON.parse(storage.data.get(KEY) as string).lectures['a.mp4'].pos).toBe(42);
    await vi.advanceTimersByTimeAsync(2100);
    expect(put).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('ProgressStore.update', () => {
  it('saves to localStorage immediately and PUTs debounced', async () => {
    vi.useFakeTimers();
    const { store, storage, put } = make({ local: state(1), remote: state(1) });
    await store.hydrate();
    store.update((s, now) => withPos(s, 'a.mp4', 12, now));
    expect(JSON.parse((storage as ReturnType<typeof memoryStore>).data.get(KEY) as string).lectures['a.mp4'].pos).toBe(12);
    expect(put).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2100);
    expect(put).toHaveBeenCalledTimes(1);
  });
  it('notifies subscribers; a no-op update does not', () => {
    const { store } = make({ local: state(1) });
    const cb = vi.fn();
    store.subscribe(cb);
    store.update((s) => s);
    expect(cb).not.toHaveBeenCalled();
    store.update((s, now) => withPos(s, 'a.mp4', 5, now));
    expect(cb).toHaveBeenCalledTimes(1);
  });
  it('works in memory when localStorage is unavailable', () => {
    const { store } = make({ storage: null });
    store.update((s, now) => withPos(s, 'a.mp4', 5, now));
    expect(store.get().lectures['a.mp4']?.pos).toBe(5);
  });
});

describe('ProgressStore.flushOnHide (pagehide)', () => {
  it('sends pending changes with keepalive', async () => {
    const { store, put } = make({ local: state(1), remote: state(1) });
    await store.hydrate();
    store.update((s, now) => withPos(s, 'a.mp4', 5, now));
    store.flushOnHide();
    expect(put).toHaveBeenCalledWith(expect.any(String), { keepalive: true });
  });
  it('sends nothing when nothing changed', async () => {
    const { store, put } = make({ local: state(1), remote: state(1) });
    await store.hydrate();
    store.flushOnHide();
    expect(put).not.toHaveBeenCalled();
  });
  it('falls back to a plain request when the body exceeds the 64 KB keepalive cap', async () => {
    const { store, put } = make({ local: state(1), remote: state(1) });
    await store.hydrate();
    store.update((s, now) => {
      let next = s;
      for (let i = 0; next === s || JSON.stringify(next).length < KEEPALIVE_LIMIT + 100; i++) {
        next = withPos(next, `${'x'.repeat(100)}-${i}.mp4`, 1, now);
      }
      return next;
    });
    store.flushOnHide();
    expect(put).toHaveBeenCalledWith(expect.any(String), { keepalive: false });
  });
});

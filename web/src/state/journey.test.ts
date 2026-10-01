import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoachMessage, JourneyFeed, JourneyStatus, ProgressSnapshot, StudentUpdate } from '../../../shared/types';
import type { KeyValueStore } from '../lib/storage';
import { JourneyStore, SnapshotPusher, type JourneyApi } from './journey';

function memoryStore(init: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

const status: JourneyStatus = {
  pace: 'on-track',
  daysDelta: 0,
  week: 1,
  totalWeeks: 10,
  targetDate: '2026-12-25',
  deadline: '2027-01-01',
  goal: null,
  coachNote: null,
  planBreak: null,
  sectionDue: { '7': '2026-10-09' },
  skippedSections: [4],
  studyWeekdays: [1, 2, 3, 4, 5],
  planBreaks: [{ label: 'Diwali', start: '2026-11-01', end: '2026-11-15' }],
};
const msg = (id: string, readAt: string | null = null): CoachMessage => ({ id, body: id, createdAt: '2026-10-01T08:00:00Z', readAt });
const upd = (replies: CoachMessage[]): StudentUpdate => ({
  id: 'u1',
  source: 'player',
  studyDate: '2026-09-30',
  createdAt: '2026-09-30T18:00:00Z',
  minutes: 72,
  sectionNumber: 7,
  sectionTitle: 'Thinking In React',
  lectures: [],
  mood: null,
  note: 'useEffect cleanup confused me',
  stuck: false,
  coachReadAt: null,
  replies,
});
const feedWith = (replies: CoachMessage[], notes: CoachMessage[] = []): JourneyFeed => ({
  updates: [upd(replies)],
  notes,
  unreadForStudent: [...replies, ...notes].filter((m) => m.readAt === null).length,
  nextCursor: null,
});

function setup(opts: { storage?: ReturnType<typeof memoryStore>; api?: Partial<JourneyApi>; connected?: boolean | (() => boolean) } = {}) {
  const storage = opts.storage ?? memoryStore();
  let now = 1_000_000;
  const reads: string[][] = [];
  const api: JourneyApi = {
    status: async () => status,
    feed: async () => ({ feed: feedWith([msg('r1'), msg('r2')], [msg('n1')]), stale: false }),
    read: async (ids) => void reads.push(ids),
    ...opts.api,
  };
  const connected = opts.connected;
  const isConnected = typeof connected === 'function' ? connected : () => connected ?? true;
  const store = new JourneyStore({ courseId: 'react-2023', profile: 'mansi', storage, api, isConnected, now: () => now });
  return { store, storage, reads, tick: (ms: number) => (now += ms) };
}

describe('JourneyStore', () => {
  it('fetches status + feed and caches both, so the next open renders at once', async () => {
    const storage = memoryStore();
    const { store } = setup({ storage });
    expect(store.get().loaded).toBe(false);
    await store.refresh();
    expect(store.get()).toMatchObject({ loaded: true, status, stale: false });
    expect(store.get().feed?.notes.map((n) => n.id)).toEqual(['n1']);
    const next = setup({ storage, api: { status: async () => null, feed: async () => null } });
    expect(next.store.get().status).toEqual(status);
    expect(next.store.get().feed?.updates).toHaveLength(1);
  });

  it('204 / unreachable keeps the last good copy and never throws', async () => {
    const storage = memoryStore();
    await setup({ storage }).store.refresh();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { store } = setup({ storage, api: { status: async () => Promise.reject(new Error('down')), feed: async () => null } });
    await expect(store.refresh()).resolves.toBeUndefined();
    expect(store.get()).toMatchObject({ loaded: true, status });
    expect(store.get().feed).not.toBeNull();
    warn.mockRestore();
  });

  it('not connected: no request, the cached status still feeds Due', async () => {
    const storage = memoryStore();
    await setup({ storage }).store.refresh();
    const statusSpy = vi.fn(async () => status);
    const { store } = setup({ storage, connected: false, api: { status: statusSpy } });
    await store.refresh();
    expect(statusSpy).not.toHaveBeenCalled();
    expect(store.get()).toMatchObject({ loaded: true, status });
  });

  it('a status cached before the plan calendar existed opens with Mon–Fri + no breaks (the streak needs both)', () => {
    const { studyWeekdays: _w, planBreaks: _p, ...older } = status;
    const storage = memoryStore({ 'cp:react-2023:mansi:status': JSON.stringify(older) });
    expect(setup({ storage }).store.get().status).toEqual({ ...status, studyWeekdays: [1, 2, 3, 4, 5], planBreaks: [] });
  });

  it('a cached plan calendar of the wrong shape is treated as missing, never trusted', () => {
    for (const bad of [{ studyWeekdays: 'Mon-Fri' }, { studyWeekdays: [1, 'x'] }, { planBreaks: [{ start: 1 }] }, { planBreaks: {} }]) {
      const storage = memoryStore({ 'cp:react-2023:mansi:status': JSON.stringify({ ...status, ...bad }) });
      expect(setup({ storage }).store.get().status).toBeNull();
    }
  });

  it('Got it: hidden at once, POSTed, and kept hidden while the server still says unread', async () => {
    const { store, reads } = setup();
    await store.refresh();
    store.markRead(['r1', 'n1']);
    expect([...store.get().readIds].sort()).toEqual(['n1', 'r1']);
    await Promise.resolve();
    expect(reads).toEqual([['r1', 'n1']]);
    await store.refresh(); // the stub still reports them unread → re-sent, still hidden
    expect([...store.get().readIds].sort()).toEqual(['n1', 'r1']);
    expect(reads.at(-1)?.sort()).toEqual(['n1', 'r1']);
  });

  it('a confirmed read leaves the local queue', async () => {
    let read = false;
    const { store } = setup({
      api: { feed: async () => ({ feed: feedWith([msg('r1', read ? '2026-10-01T09:00:00Z' : null)]), stale: false }) },
    });
    await store.refresh();
    store.markRead(['r1']);
    read = true;
    await store.refresh();
    expect(store.get().readIds.size).toBe(0);
  });

  it('a failed read POST keeps the id queued (persisted) for the next refresh', async () => {
    const storage = memoryStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { store } = setup({ storage, api: { read: async () => Promise.reject(new Error('server down')) } });
    await store.refresh();
    store.markRead(['r2']);
    await new Promise((r) => setTimeout(r, 0));
    expect(setup({ storage }).store.get().readIds.has('r2')).toBe(true);
    warn.mockRestore();
  });

  it('refreshes on focus only once 5 min have passed', async () => {
    const feed = vi.fn(async () => ({ feed: feedWith([]), stale: false }));
    const { store, tick } = setup({ api: { feed } });
    await store.refresh();
    tick(60_000);
    await store.refreshIfStale();
    expect(feed).toHaveBeenCalledTimes(1);
    tick(5 * 60_000);
    await store.refreshIfStale();
    expect(feed).toHaveBeenCalledTimes(2);
  });

  it('an open while not connected is not a fetch: the first focus after connecting fetches at once', async () => {
    let connected = false;
    const feed = vi.fn(async () => ({ feed: feedWith([]), stale: false }));
    const { store, tick } = setup({ api: { feed }, connected: () => connected });
    await store.refresh();
    connected = true;
    tick(60_000);
    await store.refreshIfStale();
    expect(feed).toHaveBeenCalledTimes(1);
  });

  it('marks a feed served from the server’s last good copy as stale', async () => {
    const { store } = setup({ api: { feed: async () => ({ feed: feedWith([]), stale: true }) } });
    await store.refresh();
    expect(store.get().stale).toBe(true);
  });
});

describe('SnapshotPusher (≤ 1 per 5 min; sign-off and Quit push at once)', () => {
  afterEach(() => vi.useRealTimers());
  const snap = (takenAt: number): ProgressSnapshot => ({
    course: 'react-2023',
    takenAt,
    lecturesDone: 1,
    lecturesTotal: 410,
    videoSecondsDone: 60,
    videoSecondsTotal: 241_822,
    sectionsDone: [],
    current: null,
    days: {},
  });

  function pusher(connected = true) {
    vi.useFakeTimers();
    const puts: ProgressSnapshot[] = [];
    const p = new SnapshotPusher({ build: () => snap(Date.now()), put: async (s) => void puts.push(s), isConnected: () => connected });
    return { p, puts };
  }

  it('a burst of changes → one push after the quiet delay, then at most one per 5 min', async () => {
    const { p, puts } = pusher();
    p.changed();
    p.changed();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(puts).toHaveLength(1);
    p.changed();
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(puts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(puts).toHaveLength(2);
  });

  it('pushNow sends at once and cancels the pending debounce', async () => {
    const { p, puts } = pusher();
    p.changed();
    await p.pushNow();
    expect(puts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(puts).toHaveLength(1);
  });

  it('pagehide flushes a pending debounce with keepalive, and does nothing when none is pending', async () => {
    vi.useFakeTimers();
    const sent: boolean[] = [];
    const p = new SnapshotPusher({ build: () => snap(Date.now()), put: async (_s, o) => void sent.push(o.keepalive), isConnected: () => true });
    p.flushOnHide();
    expect(sent).toEqual([]);
    p.changed();
    p.flushOnHide();
    await Promise.resolve();
    expect(sent).toEqual([true]);
  });

  it('not connected → nothing is pushed', async () => {
    const { p, puts } = pusher(false);
    p.changed();
    await p.pushNow();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(puts).toHaveLength(0);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoachMessage, JourneyFeed, JourneySession, JourneyStatus, OutboxState, OutboxUpdate, ProgressSnapshot, StudentUpdate } from '../../../shared/types';
import { ApiError } from '../lib/api';
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

const EMPTY_OUTBOX: OutboxState = { pending: 0, lastError: null, updates: [] };
const session = (id: string): JourneySession => ({
  id,
  course: 'react-2023',
  startedAt: '2026-10-05T03:44:00.000Z',
  endedAt: '2026-10-05T05:07:00.000Z',
  studyDate: '2026-10-05',
  minutes: 83,
  sectionNumber: 7,
  lecturesCompleted: [],
  finishedSections: [],
  mood: null,
  note: 'props clicked',
  stuck: false,
  autoClosed: false,
  progress: null,
});
const queued = (id: string): OutboxUpdate => ({ id, state: 'queued', at: '2026-10-05T05:07:00.000Z', error: null, session: session(id) });
const rejected = (id: string): OutboxUpdate => ({ id, state: 'rejected', at: '2026-10-05T05:08:00.000Z', error: 'HTTP 404 — unknown course', session: session(id) });
const delivered = (id: string): OutboxUpdate => ({ id, state: 'delivered', at: '2026-10-05T05:09:00.000Z', error: null });
const outboxOf = (updates: OutboxUpdate[]): OutboxState => ({ pending: updates.filter((u) => u.state === 'queued').length, lastError: null, updates });

function setup(opts: { storage?: ReturnType<typeof memoryStore>; api?: Partial<JourneyApi>; connected?: boolean | (() => boolean) } = {}) {
  const storage = opts.storage ?? memoryStore();
  let now = 1_000_000;
  const reads: string[][] = [];
  const api: JourneyApi = {
    status: async () => status,
    feed: async () => ({ feed: feedWith([msg('r1'), msg('r2')], [msg('n1')]), stale: false }),
    read: async (ids) => void reads.push(ids),
    outbox: async () => EMPTY_OUTBOX,
    retry: async () => EMPTY_OUTBOX,
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

  it('a cached plan (See full plan) of the wrong shape is dropped — the rest of the status stays', () => {
    const plan = [{ kind: 'week', week: 1, due: '2026-10-09', goal: '§7 Thinking In React', state: 'current' }];
    const good = memoryStore({ 'cp:react-2023:mansi:status': JSON.stringify({ ...status, plan }) });
    expect(setup({ storage: good }).store.get().status?.plan).toEqual(plan);
    for (const bad of ['x', [{ kind: 'week', week: '1' }], [{ kind: 'month' }]]) {
      const storage = memoryStore({ 'cp:react-2023:mansi:status': JSON.stringify({ ...status, plan: bad }) });
      const cached = setup({ storage }).store.get().status;
      expect(cached?.week).toBe(1);
      expect(cached?.plan).toBeUndefined();
    }
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

describe('JourneyStore v3: a course JS Journey does not know is a visible state (spec v3 A1)', () => {
  const problem = { error: "JS Journey doesn't know the course 'react-course' — ask Rahul", problem: 'unknown-course' as const, courseId: 'react-course' };

  it('status 409 + JourneyProblem → `problem` (the menu says "course not recognised"), the cached status stays', async () => {
    const storage = memoryStore();
    await setup({ storage }).store.refresh();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { store } = setup({ storage, api: { status: async () => Promise.reject(new ApiError(409, problem.error, problem)) } });
    await store.refresh();
    expect(store.get()).toMatchObject({ problem, status });
    warn.mockRestore();
  });

  it('a good status clears it again; any other failure leaves it as it was', async () => {
    let fail: Error | null = new ApiError(409, problem.error, problem);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { store } = setup({
      api: {
        status: async () => {
          if (fail) throw fail;
          return status;
        },
      },
    });
    await store.refresh();
    expect(store.get().problem).toEqual(problem);
    fail = new Error('offline');
    await store.refresh();
    expect(store.get().problem).toEqual(problem);
    fail = null;
    await store.refresh();
    expect(store.get().problem).toBeNull();
    warn.mockRestore();
  });
});

describe('JourneyStore v3: her updates in the local outbox (spec v3 A2, A5, A6)', () => {
  it('read on every refresh — connected or NOT (updates wait there until she connects)', async () => {
    const outbox = vi.fn(async () => outboxOf([queued('q'), rejected('r'), delivered('d')]));
    const { store } = setup({ connected: false, api: { outbox } });
    await store.refresh();
    expect(outbox).toHaveBeenCalled();
    expect(store.get().outbox.map((u) => [u.id, u.state])).toEqual([
      ['q', 'queued'],
      ['r', 'rejected'],
      ['d', 'delivered'],
    ]);
  });

  it('an unreachable course server keeps the last list and says so in the console, never throws', async () => {
    let down = false;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { store } = setup({
      api: {
        outbox: async () => {
          if (down) throw new Error('server down');
          return outboxOf([queued('q')]);
        },
      },
    });
    await store.refresh();
    down = true;
    await expect(store.refresh()).resolves.toBeUndefined();
    expect(store.get().outbox.map((u) => u.id)).toEqual(['q']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('noteOutbox: the 202 answer of a sign-off shows "Waiting to send" at once', () => {
    const { store } = setup();
    store.noteOutbox(outboxOf([queued('q')]));
    expect(store.get().outbox.map((u) => u.id)).toEqual(['q']);
  });

  it('awaitDelivery: one GET outbox?wait= → delivered / still queued / rejected, and the list updates', async () => {
    const waits: (number | undefined)[] = [];
    let answer = outboxOf([delivered('a')]);
    const { store } = setup({
      api: {
        outbox: async (waitMs) => {
          waits.push(waitMs);
          return answer;
        },
      },
    });
    await expect(store.awaitDelivery('a', 8000)).resolves.toEqual({ state: 'delivered' });
    answer = outboxOf([rejected('a')]);
    await expect(store.awaitDelivery('a', 8000)).resolves.toEqual({ state: 'rejected', error: 'HTTP 404 — unknown course' });
    expect(store.get().outbox.map((u) => u.state)).toEqual(['rejected']);
    expect(waits).toEqual([8000, 8000]);
  });

  it('Try again: re-queues that update, waits for the answer, and refreshes the feed when it went through', async () => {
    const retried: string[][] = [];
    const feed = vi.fn(async () => ({ feed: feedWith([]), stale: false }));
    const { store } = setup({
      api: {
        retry: async (ids) => {
          retried.push(ids);
          return outboxOf([queued('r')]);
        },
        outbox: async () => outboxOf([delivered('r')]),
        feed,
      },
    });
    await expect(store.retry('r')).resolves.toEqual({ state: 'delivered' });
    expect(retried).toEqual([['r']]);
    expect(feed).toHaveBeenCalled();
  });
});

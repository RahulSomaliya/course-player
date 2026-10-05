// JS Journey, seen from the browser (docs/spec-v2-coaching.md "Feed", "Progress snapshot"):
// - JourneyStore: her plan status + Rahul's feed. Fetched on app open, on focus after 5 min and after
//   a sign-off; the last good copy of each is cached in localStorage so the next open renders at once
//   (and Due + the streak's plan calendar keep a value offline). "Got it" goes through a local read
//   queue (lib/feed.ts).
//   v3 (docs/spec-v3-study-timer.md): also her updates in the LOCAL outbox (queued / rejected / delivered
//   receipts — read connected or not: updates wait there until she connects), the delivery answer the
//   sign-off card shows (awaitDelivery), "Try again" (retry), and `problem` = JS Journey does not know
//   this copy's course id (status 409) — shown in the menu, never mistaken for "offline".
// - SnapshotPusher: PUTs her progress snapshot, ≤ 1 per 5 min on changes, at once on sign-off/Quit.
// Everything goes through the local server (lib/api.ts), which holds the token and retries.
import { createContext, useContext, useSyncExternalStore } from 'react';
import type { JourneyFeed, JourneyProblem, JourneyStatus, OutboxState, OutboxUpdate, PlanRow, ProgressSnapshot } from '../../../shared/types';
import { ApiError } from '../lib/api';
import { isJourneyFeed, readQueueAfter, shouldRefetch } from '../lib/feed';
import { deliveryOf, type Delivery } from '../lib/outbox';
import { nextPushDelay } from '../lib/snapshot';
import { DEFAULT_CALENDAR } from '../lib/stats';
import { readJson, writeJson, type KeyValueStore } from '../lib/storage';

export interface JourneyApi {
  /** null = 204 (not connected / JS Journey unreachable); throws ApiError with `problem` on 409 */
  status: () => Promise<JourneyStatus | null>;
  feed: () => Promise<{ feed: JourneyFeed; stale: boolean } | null>;
  read: (ids: string[]) => Promise<void>;
  /** the local outbox; `waitMs` = answer once the deliveries in flight settled (≤ that long) */
  outbox: (waitMs?: number) => Promise<OutboxState>;
  /** "Try again": re-queue these rejected updates */
  retry: (ids: string[]) => Promise<OutboxState>;
}

/** how long the sign-off card / Try again wait for JS Journey's answer before saying "Saved ✓" */
export const DELIVERY_WAIT_MS = 8000;

export interface JourneyState {
  status: JourneyStatus | null;
  feed: JourneyFeed | null;
  /** the feed came from the server's last good copy (JS Journey offline) */
  stale: boolean;
  /** messages she marked read here that the server has not confirmed yet */
  readIds: ReadonlySet<string>;
  /** the first refresh after open has settled (screens wait for it briefly, see App.tsx) */
  loaded: boolean;
  /** her updates in the local outbox (OutboxState.updates: queued, rejected, recent delivered receipts) */
  outbox: OutboxUpdate[];
  /** JS Journey answered "unknown course" for this copy's id (status 409) — null once a status works */
  problem: JourneyProblem | null;
}

export interface JourneyStoreOptions {
  courseId: string;
  profile: string;
  storage: KeyValueStore | null;
  api: JourneyApi;
  isConnected: () => boolean;
  now?: () => number;
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isStrings = (x: unknown): x is string[] => Array.isArray(x) && x.every((v) => typeof v === 'string');

/** A status cached before the plan calendar (studyWeekdays / planBreaks) existed lacks it; `plan` is
 *  checked on its own (fromCache). */
type CachedStatus = Omit<JourneyStatus, 'studyWeekdays' | 'planBreaks' | 'plan'> &
  Partial<Pick<JourneyStatus, 'studyWeekdays' | 'planBreaks'>> & { plan?: unknown };

const isBreak = (b: unknown): boolean =>
  isRecord(b) && typeof b.label === 'string' && typeof b.start === 'string' && typeof b.end === 'string';

/** Enough shape to render This week / Due / the streak from a cached copy; the server validated the live
 *  one. A plan calendar of the wrong shape → the whole copy is missing (the streak would walk garbage). */
export function isCachedStatus(x: unknown): x is CachedStatus {
  return (
    isRecord(x) &&
    (x.pace === 'ahead' || x.pace === 'on-track' || x.pace === 'behind') &&
    typeof x.daysDelta === 'number' &&
    typeof x.week === 'number' &&
    typeof x.totalWeeks === 'number' &&
    typeof x.targetDate === 'string' &&
    (x.studyWeekdays === undefined || (Array.isArray(x.studyWeekdays) && x.studyWeekdays.every((d: unknown) => typeof d === 'number'))) &&
    (x.planBreaks === undefined || (Array.isArray(x.planBreaks) && x.planBreaks.every(isBreak)))
  );
}

const isStr = (x: unknown): x is string => typeof x === 'string';
const WEEK_STATES = new Set(['done', 'current', 'behind', 'upcoming', 'past']);

/** One row of JourneyStatus.plan (the server validated the live copy; this is the cached one). */
function isPlanRow(x: unknown): x is PlanRow {
  if (!isRecord(x)) return false;
  if (x.kind === 'week') return typeof x.week === 'number' && isStr(x.due) && isStr(x.goal) && isStr(x.state) && WEEK_STATES.has(x.state);
  return x.kind === 'break' && isStr(x.label) && isStr(x.start) && isStr(x.end) && typeof x.now === 'boolean';
}

/** The cached copy with the plan calendar filled (Mon–Fri, no breaks) when it predates it — else the
 *  streak would read `undefined` until the first refresh, or for good while offline. A plan of the wrong
 *  shape is dropped on its own (it only feeds "See full plan", which hides without it). */
function fromCache(s: CachedStatus | null): JourneyStatus | null {
  if (s === null) return null;
  const { plan, ...rest } = s;
  const okPlan = Array.isArray(plan) && plan.every(isPlanRow) ? { plan } : {};
  return { ...rest, ...okPlan, studyWeekdays: s.studyWeekdays ?? [...DEFAULT_CALENDAR.studyWeekdays], planBreaks: s.planBreaks ?? [] };
}

export class JourneyStore {
  private state: JourneyState;
  private lastFetchAt: number | null = null;
  private inflight: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly keys: { status: string; feed: string; read: string };
  private readonly now: () => number;

  constructor(private readonly opts: JourneyStoreOptions) {
    const base = `cp:${opts.courseId}:${opts.profile}`;
    this.keys = { status: `${base}:status`, feed: `${base}:feed`, read: `${base}:read` };
    this.now = opts.now ?? Date.now;
    this.state = {
      status: fromCache(readJson(opts.storage, this.keys.status, isCachedStatus)),
      feed: readJson(opts.storage, this.keys.feed, isJourneyFeed),
      stale: false,
      readIds: new Set(readJson(opts.storage, this.keys.read, isStrings) ?? []),
      loaded: false,
      outbox: [],
      problem: null,
    };
  }

  get = (): JourneyState => this.state;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  /** Never throws: offline keeps the cached copies. Concurrent calls share one round trip. */
  refresh(): Promise<void> {
    this.inflight ??= this.load().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  refreshIfStale(): Promise<void> {
    return shouldRefetch(this.lastFetchAt, this.now()) ? this.refresh() : Promise.resolve();
  }

  /** "Got it": hide at once, tell JS Journey (the local server queues and retries the POST). */
  markRead(ids: string[]): void {
    if (ids.length === 0) return;
    this.setReadIds(new Set([...this.state.readIds, ...ids]));
    void this.postRead(ids);
  }

  /** The 202 answer of a sign-off (POST sessions): "Waiting to send" shows at once. */
  noteOutbox(o: OutboxState): void {
    this.set({ outbox: o.updates });
  }

  /** What became of update `id`: one GET outbox?wait= (the server holds it until the deliveries in flight
   *  settled, ≤ waitMs). Throws when the course server does not answer — the caller says what that means. */
  async awaitDelivery(id: string, waitMs = DELIVERY_WAIT_MS): Promise<Delivery> {
    const o = await this.opts.api.outbox(waitMs);
    this.noteOutbox(o);
    return deliveryOf(o, id);
  }

  /** "Try again" on a rejected update ("Your updates"): re-queue it, wait for the answer; once it went
   *  through, the feed (which now has it) is fetched. Throws when the course server does not answer. */
  async retry(id: string): Promise<Delivery> {
    this.noteOutbox(await this.opts.api.retry([id]));
    const delivery = await this.awaitDelivery(id);
    if (delivery.state === 'delivered') await this.refresh();
    return delivery;
  }

  private async loadOutbox(): Promise<void> {
    try {
      this.noteOutbox(await this.opts.api.outbox());
    } catch (err) {
      console.warn('[journey] the outbox is unreadable right now — keeping the last list', err);
    }
  }

  private async loadStatus(): Promise<JourneyStatus | null> {
    try {
      const status = await this.opts.api.status();
      if (status !== null) this.set({ problem: null });
      return status;
    } catch (err) {
      // v3: JS Journey does not know this copy's course id. Visible (menu), not "offline": that silence is
      // how the 2026-10-05 sign-off vanished unnoticed. The cached status still feeds This week / Due.
      if (err instanceof ApiError && err.problem !== null) this.set({ problem: err.problem });
      console.warn('[journey] plan status unavailable — keeping the last copy', err);
      return null;
    }
  }

  private async load(): Promise<void> {
    // The outbox is LOCAL and holds updates whether or not she is connected (v3): always read it.
    const outbox = this.loadOutbox();
    if (!this.opts.isConnected()) {
      // Not a fetch: leave lastFetchAt alone, so the first focus after connecting refetches at once
      // instead of waiting out the 5 min (App.tsx also refreshes the moment she connects).
      await outbox;
      this.set({ loaded: true, problem: null });
      return;
    }
    this.lastFetchAt = this.now();
    const [status, feed] = await Promise.all([
      this.loadStatus(),
      this.opts.api.feed().catch((err: unknown) => {
        console.warn('[journey] feed unavailable — keeping the last copy', err);
        return null;
      }),
      outbox,
    ]);
    if (status !== null) writeJson(this.opts.storage, this.keys.status, status);
    if (feed !== null) writeJson(this.opts.storage, this.keys.feed, feed.feed);
    this.set({
      loaded: true,
      status: status ?? this.state.status,
      feed: feed?.feed ?? this.state.feed,
      stale: feed?.stale ?? this.state.stale,
    });
    if (feed !== null) {
      const queue = readQueueAfter(this.state.readIds, feed.feed);
      this.setReadIds(queue);
      // Marked read here but not confirmed: the earlier POST was lost (server restarted, offline) → again.
      if (queue.size > 0) void this.postRead([...queue]);
    }
  }

  private async postRead(ids: string[]): Promise<void> {
    try {
      await this.opts.api.read(ids);
    } catch (err) {
      console.warn(`[journey] could not mark ${ids.length} message(s) read yet — will retry on the next refresh`, err);
    }
  }

  private setReadIds(next: Set<string>): void {
    const same = next.size === this.state.readIds.size && [...next].every((id) => this.state.readIds.has(id));
    if (same) return;
    writeJson(this.opts.storage, this.keys.read, [...next]);
    this.set({ readIds: next });
  }

  private set(patch: Partial<JourneyState>): void {
    this.state = { ...this.state, ...patch };
    for (const cb of this.listeners) cb();
  }
}

export interface SnapshotPusherOptions {
  build: () => ProgressSnapshot;
  put: (snapshot: ProgressSnapshot, opts: { keepalive: boolean }) => Promise<void>;
  isConnected: () => boolean;
}

export class SnapshotPusher {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastPushAt: number | null = null;

  constructor(private readonly opts: SnapshotPusherOptions) {}

  /** Progress changed: push after a short quiet delay, never sooner than 5 min after the last push. */
  changed(): void {
    if (this.timer !== null || !this.opts.isConnected()) return;
    this.timer = setTimeout(() => void this.pushNow(), nextPushDelay(this.lastPushAt, Date.now()));
  }

  /** Sign-off / Quit / pagehide. Never throws — the server retries what it accepted. */
  async pushNow(opts: { keepalive?: boolean } = {}): Promise<void> {
    this.cancel();
    if (!this.opts.isConnected()) return;
    this.lastPushAt = Date.now();
    try {
      await this.opts.put(this.opts.build(), { keepalive: opts.keepalive ?? false });
    } catch (err) {
      console.warn('[journey] progress snapshot not handed to the course server — the next change retries', err);
    }
  }

  /** The tab is closing with a debounced push still waiting: send it now (keepalive), or it is lost. */
  flushOnHide(): void {
    if (this.timer !== null) void this.pushNow({ keepalive: true });
  }

  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

export const JourneyContext = createContext<JourneyStore | null>(null);

export function useJourneyStore(): JourneyStore {
  const store = useContext(JourneyContext);
  if (store === null) throw new Error('useJourneyStore outside <JourneyContext>');
  return store;
}

export function useJourney(): JourneyState {
  const store = useJourneyStore();
  return useSyncExternalStore(store.subscribe, store.get);
}

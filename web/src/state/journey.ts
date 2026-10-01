// JS Journey, seen from the browser (docs/spec-v2-coaching.md "Feed", "Progress snapshot"):
// - JourneyStore: her plan status + Rahul's feed. Fetched on app open, on focus after 5 min and after
//   a sign-off; the last good copy of each is cached in localStorage so the next open renders at once
//   (and Due + the streak's plan calendar keep a value offline). "Got it" goes through a local read
//   queue (lib/feed.ts).
// - SnapshotPusher: PUTs her progress snapshot, ≤ 1 per 5 min on changes, at once on sign-off/Quit.
// Everything goes through the local server (lib/api.ts), which holds the token and retries.
import { createContext, useContext, useSyncExternalStore } from 'react';
import type { JourneyFeed, JourneyStatus, ProgressSnapshot } from '../../../shared/types';
import { isJourneyFeed, readQueueAfter, shouldRefetch } from '../lib/feed';
import { nextPushDelay } from '../lib/snapshot';
import { DEFAULT_CALENDAR } from '../lib/stats';
import { readJson, writeJson, type KeyValueStore } from '../lib/storage';

export interface JourneyApi {
  /** null = 204 (not connected / JS Journey unreachable) */
  status: () => Promise<JourneyStatus | null>;
  feed: () => Promise<{ feed: JourneyFeed; stale: boolean } | null>;
  read: (ids: string[]) => Promise<void>;
}

export interface JourneyState {
  status: JourneyStatus | null;
  feed: JourneyFeed | null;
  /** the feed came from the server's last good copy (JS Journey offline) */
  stale: boolean;
  /** messages she marked read here that the server has not confirmed yet */
  readIds: ReadonlySet<string>;
  /** the first refresh after open has settled (screens wait for it briefly, see App.tsx) */
  loaded: boolean;
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

/** A status cached before the plan calendar (studyWeekdays / planBreaks) existed lacks it. */
type CachedStatus = Omit<JourneyStatus, 'studyWeekdays' | 'planBreaks'> & Partial<Pick<JourneyStatus, 'studyWeekdays' | 'planBreaks'>>;

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

/** The cached copy with the plan calendar filled (Mon–Fri, no breaks) when it predates it — else the
 *  streak would read `undefined` until the first refresh, or for good while offline. */
function fromCache(s: CachedStatus | null): JourneyStatus | null {
  if (s === null) return null;
  return { ...s, studyWeekdays: s.studyWeekdays ?? [...DEFAULT_CALENDAR.studyWeekdays], planBreaks: s.planBreaks ?? [] };
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

  private async load(): Promise<void> {
    if (!this.opts.isConnected()) {
      // Not a fetch: leave lastFetchAt alone, so the first focus after connecting refetches at once
      // instead of waiting out the 5 min (App.tsx also refreshes the moment she connects).
      this.set({ loaded: true });
      return;
    }
    this.lastFetchAt = this.now();
    const [status, feed] = await Promise.all([
      this.opts.api.status().catch((err: unknown) => {
        console.warn('[journey] plan status unavailable — keeping the last copy', err);
        return null;
      }),
      this.opts.api.feed().catch((err: unknown) => {
        console.warn('[journey] feed unavailable — keeping the last copy', err);
        return null;
      }),
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

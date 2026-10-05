// The per-profile progress store (spec "Progress & storage"):
// - localStorage `cp:<course>:<profile>:progress` is primary and is written on every change;
// - the SSD copy (GET/PUT /api/progress/:profile) follows, debounced 2 s (max 30 s while a playing
//   video keeps saving its position), so progress follows the drive to any Mac and survives a cleared browser;
// - on boot the copy with the larger updatedAt wins (LWW, same rule as server/store.ts pickNewer).
// - until that boot read (hydrate) settles, changes stay in memory: they are replayed on top of a newer
//   SSD copy instead of stamping the local copy "newest" and overwriting the SSD (see update()).
import { createContext, useContext, useSyncExternalStore } from 'react';
import type { ProgressState } from '../../../shared/types';
import * as api from '../lib/api';
import { emptyProgress, isProgressState, pickNewer } from '../lib/progress';
import { createSaver, readJson, writeJson, type KeyValueStore, type Saver } from '../lib/storage';

/** Browsers reject keepalive bodies over 64 KiB; 410 lectures of progress can approach that. */
export const KEEPALIVE_LIMIT = 60_000;

export const progressKey = (courseId: string, profile: string): string => `cp:${courseId}:${profile}:progress`;

export interface ProgressApi {
  get: () => Promise<unknown>;
  put: (body: string, opts: { keepalive: boolean }) => Promise<void>;
}

export interface ProgressStoreOptions {
  courseId: string;
  profile: string;
  storage: KeyValueStore | null;
  api?: ProgressApi;
  now?: () => number;
}

type Change = (s: ProgressState, now: number) => ProgressState;

export class ProgressStore {
  private state: ProgressState;
  /** the local copy as it was when the store opened, before any change stamped it */
  private readonly opened: ProgressState;
  private dirty = false;
  private hydration: Promise<void> | null = null;
  private hydrated = false;
  /** changes applied before hydrate() settled, replayed onto a newer SSD copy */
  private early: Change[] = [];
  private readonly key: string;
  private readonly listeners = new Set<() => void>();
  private readonly saver: Saver;
  private readonly api: ProgressApi;
  private readonly now: () => number;
  private readonly storage: KeyValueStore | null;
  readonly profile: string;

  constructor(opts: ProgressStoreOptions) {
    this.profile = opts.profile;
    this.key = progressKey(opts.courseId, opts.profile);
    this.storage = opts.storage;
    this.now = opts.now ?? Date.now;
    this.api = opts.api ?? {
      get: () => api.getProgress(opts.profile),
      put: (body, o) => api.putProgress(opts.profile, body, o),
    };
    this.state = readJson(this.storage, this.key, isProgressState) ?? emptyProgress();
    this.opened = this.state;
    this.saver = createSaver(() => void this.push(false), { delayMs: 2000, maxWaitMs: 30_000 });
  }

  get = (): ProgressState => this.state;

  /** true once the boot read of the SSD copy settled — before that the state may still be replaced */
  isHydrated = (): boolean => this.hydrated;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  /**
   * Applies a pure change (lib/progress.ts with* helpers). Returning the same object is a no-op.
   *
   * Before hydrate() settles the change stays in memory (no localStorage write, no PUT) and is queued.
   * WHY: every change stamps `updatedAt = now`, so an early change makes even an EMPTY local copy (a
   * cleared browser) "newer" than the SSD copy — LWW then kept it and PUT it over the SSD copy, wiping
   * every done lecture and study day. A child's mount effect (WatchScreen `withLast`) runs before
   * ProfileApp's hydrate effect, so this is the normal boot order, not a race. Persisting the stamped
   * copy early would bring the same loss back on the next boot if the tab closed mid-GET.
   */
  update(change: Change): void {
    const next = change(this.state, this.now());
    if (next === this.state) return;
    if (!this.hydrated) {
      this.early.push(change);
      this.state = next;
      this.notify();
      return;
    }
    this.set(next);
    this.dirty = true;
    this.saver.schedule();
  }

  /** Boot: fetch the SSD copy and keep whichever copy is newer. Never throws — offline keeps the local copy.
   *  Idempotent: StrictMode runs ProfileApp's effect twice, and both callers share the one GET. */
  hydrate(): Promise<void> {
    this.hydration ??= this.load();
    return this.hydration;
  }

  private async load(): Promise<void> {
    let remote: ProgressState | null = null;
    let reachable = true;
    try {
      const raw = await this.api.get();
      remote = isProgressState(raw) ? raw : null;
      if (raw !== null && remote === null) console.warn(`[progress] ${this.profile}: ignoring an unreadable SSD copy`);
    } catch (err) {
      reachable = false;
      console.warn(`[progress] ${this.profile}: SSD copy unreachable — using this browser's copy`, err);
    }
    const early = this.early;
    this.early = [];
    this.hydrated = true;
    // LWW against the copy this browser OPENED with — `this.state` may carry early changes stamped "now".
    if (remote !== null && pickNewer(this.opened, remote) === remote) {
      // The SSD copy wins: adopt it and replay the early changes on top, each re-stamped.
      const replayed = early.reduce<ProgressState>((s, change) => change(s, this.now()), remote);
      this.set(replayed);
      if (replayed === remote) return;
    } else {
      if (early.length > 0) writeJson(this.storage, this.key, this.state);
      if (!reachable) {
        if (early.length > 0) {
          this.dirty = true;
          this.saver.schedule();
        }
        return;
      }
      // Local is newer → bring the SSD copy up to date (a pristine, never-touched profile writes nothing).
      const localNewer = remote === null ? this.state.updatedAt > 0 : this.state.updatedAt > remote.updatedAt;
      if (!localNewer) return;
    }
    this.dirty = true;
    await this.push(false);
  }

  /** pagehide: send pending changes with keepalive so they survive the tab closing. */
  flushOnHide(): void {
    this.saver.cancel();
    if (this.dirty) void this.push(true);
  }

  /** Quit: make sure the SSD copy is current before the server stops. */
  async flushNow(): Promise<void> {
    if (this.hydration !== null) await this.hydration;
    this.saver.cancel();
    if (this.dirty) await this.push(false);
  }

  dispose(): void {
    this.flushOnHide();
    this.listeners.clear();
  }

  private set(next: ProgressState): void {
    this.state = next;
    writeJson(this.storage, this.key, next);
    this.notify();
  }

  private notify(): void {
    for (const cb of this.listeners) cb();
  }

  private async push(keepalive: boolean): Promise<void> {
    const body = JSON.stringify(this.state);
    this.dirty = false;
    try {
      // Over the keepalive cap the browser rejects the request outright; a plain request may still
      // land, and localStorage already holds the change (the next boot re-pushes it via LWW).
      await this.api.put(body, { keepalive: keepalive && body.length <= KEEPALIVE_LIMIT });
    } catch (err) {
      this.dirty = true;
      console.warn(`[progress] ${this.profile}: saving to the SSD failed — will retry on the next change`, err);
    }
  }
}

export const ProgressContext = createContext<ProgressStore | null>(null);

export function useProgressStore(): ProgressStore {
  const store = useContext(ProgressContext);
  if (store === null) throw new Error('useProgressStore outside <ProgressContext>');
  return store;
}

/** Subscribe to a slice. Return stable references (e.g. `s => s.lectures`), not fresh objects. */
export function useProgress<T>(select: (s: ProgressState) => T): T {
  const store = useProgressStore();
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}

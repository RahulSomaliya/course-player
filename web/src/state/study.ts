// Drives study time + sign-offs (docs/spec.md "Study time"; docs/spec-v2-coaching.md "Sign-off card").
// The player and the article view report what is open/playing via setActivity; a 1 s interval credits
// studied seconds to ProgressState.days and to the live session.
//
// v2: every sign-off is one update for Rahul, so nothing ends or sends a session by itself any more:
// - `live` = what she studied since her last sign-off. 20 min without studying → `waiting` (the header
//   dot); studying again the same day continues it, on another day it moves to `pending` first.
// - `pending` = earlier sittings she closed the app on without signing off. On the next open the
//   sign-off card asks for their note ("You studied 1h 12m on Tue — add a note for Rahul?").
// - An earlier session she closes the card on ("still skips", skip()) is sent with autoClosed: true once
//   it is older than 24 h (since its last studied second), so Rahul never misses study time. Never
//   before the card has asked: a 2-day-old session at the next open still gets its card first.
//   Checked on open (App.tsx, AFTER hydrate — never from resume()), on skip and about once a minute.
//   An auto-closing session leaves `pending` the moment its POST starts, and a session the open card is
//   asking about (hold()) is left alone: otherwise the card asks for a note on a session already on its
//   way, and her note is dropped (2026-10-01 review — see autoClose()).
// Both are persisted (`cp:<course>:<profile>:session`, `…:pending`) so a reload or a closed tab loses nothing.
import { createContext, useContext, useSyncExternalStore } from 'react';
import type { JourneySession, ProgressSnapshot } from '../../../shared/types';
import type { CourseIndex } from '../lib/course';
import { isSectionDone } from '../lib/course';
import { localDateKey } from '../lib/dates';
import { withDone, withStudy } from '../lib/progress';
import {
  PENDING_MAX_AGE_MS,
  accumulate,
  addCompleted,
  addFinishedSection,
  isLiveSession,
  isWaiting,
  removeCompleted,
  toUpdate,
  type LiveSession,
  type SignOffAnswer,
  type SignOffTarget,
} from '../lib/session';
import { readJson, writeJson, writeString, type KeyValueStore } from '../lib/storage';
import { StudyTicker, isStudying } from '../lib/ticker';
import type { ProgressStore } from './progress';

export const sessionKey = (courseId: string, profile: string): string => `cp:${courseId}:${profile}:session`;
export const pendingKey = (courseId: string, profile: string): string => `cp:${courseId}:${profile}:pending`;
/** v1 stored an ended session waiting for its wrap-up card here; resume() moves it into `pending`. */
export const legacyWrapKey = (courseId: string, profile: string): string => `cp:${courseId}:${profile}:wrap`;

/** how often (in ticks ≈ seconds) the 24 h rule is checked while the app is open */
const AUTO_CLOSE_EVERY_TICKS = 60;
/** Quit asks for a sign-off from this much unsigned study time (a few seconds is not a session) */
const QUIT_ASKS_FROM_SECONDS = 60;

/** An earlier sitting; `skippedAt` = when she closed the sign-off card on it without answering. */
export type PendingSession = LiveSession & { skippedAt?: number | null };

export interface StudyState {
  live: LiveSession | null;
  /** oldest first */
  pending: PendingSession[];
  /** the live session has had no study for 20 min */
  waiting: boolean;
}

/** 'gone' = the session already went to Rahul without her (the 24 h rule): her answer was not sent. */
export type SignOffResult = 'sent' | 'skipped' | 'failed' | 'gone';

export interface Activity {
  lectureId: string | null;
  playing: boolean;
  reading: boolean;
}

export interface StudyDeps {
  courseId: string;
  profile: string;
  progress: ProgressStore;
  index: CourseIndex;
  storage: KeyValueStore | null;
  /** read at send time: connecting JS Journey mid-session still sends that session */
  isConnected: () => boolean;
  send: (session: JourneySession) => Promise<unknown>;
  /** her progress right now — every update carries it */
  snapshot: () => ProgressSnapshot;
  clock?: { now: () => number; perf: () => number };
  isVisible?: () => boolean;
  newId?: () => string;
}

function isPendingList(x: unknown): x is PendingSession[] {
  return (
    Array.isArray(x) &&
    x.every((p) => {
      if (!isLiveSession(p)) return false;
      const skippedAt = (p as PendingSession).skippedAt;
      return skippedAt == null || (typeof skippedAt === 'number' && Number.isFinite(skippedAt));
    })
  );
}

function isLegacyWrap(x: unknown): x is { session: LiveSession } {
  return typeof x === 'object' && x !== null && isLiveSession((x as { session?: unknown }).session);
}

const NO_ANSWER: SignOffAnswer = { mood: null, note: null, stuck: false };
const byStart = (list: PendingSession[]): PendingSession[] => list.sort((a, b) => a.startedAt - b.startedAt);

export class StudyController {
  private state: StudyState = { live: null, pending: [], waiting: false };
  private activity: Activity = { lectureId: null, playing: false, reading: false };
  private lastInputAt: number;
  private ticks = 0;
  /** sessions being auto-closed right now: out of `pending` (no card, dot or Quit asks about them) but
   *  still in storage until the POST lands, so a tab closed meanwhile loses nothing */
  private readonly closing = new Map<string, PendingSession>();
  /** session ids the open sign-off card asks about: the 24 h rule leaves them to her answer */
  private readonly held = new Set<string>();
  private readonly ticker: StudyTicker;
  private readonly listeners = new Set<() => void>();
  private readonly key: string;
  private readonly pendingKey: string;
  private readonly now: () => number;
  private readonly perf: () => number;
  private readonly visible: () => boolean;
  private readonly newId: () => string;

  constructor(private readonly deps: StudyDeps) {
    this.key = sessionKey(deps.courseId, deps.profile);
    this.pendingKey = pendingKey(deps.courseId, deps.profile);
    this.now = deps.clock?.now ?? Date.now;
    this.perf = deps.clock?.perf ?? (() => performance.now());
    this.visible = deps.isVisible ?? (() => document.visibilityState === 'visible');
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.lastInputAt = this.perf();
    this.ticker = new StudyTicker(this.perf());
  }

  getState = (): StudyState => this.state;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  /** App open: restore the live session, or — when it has been idle > 20 min (the app was closed on
   *  it) — turn it into a pending one whose note the card asks for. The 24 h rule is NOT applied here:
   *  App calls autoClose() once hydrate settled (its update carries the SSD copy of her progress), and
   *  before it reads the queue for the at-open card. */
  resume(): void {
    const pending: PendingSession[] = readJson(this.deps.storage, this.pendingKey, isPendingList) ?? [];
    const legacy = readJson(this.deps.storage, legacyWrapKey(this.deps.courseId, this.deps.profile), isLegacyWrap);
    if (legacy !== null) {
      if (!pending.some((p) => p.id === legacy.session.id)) pending.push(legacy.session);
      writeString(this.deps.storage, legacyWrapKey(this.deps.courseId, this.deps.profile), null);
    }
    let live = readJson(this.deps.storage, this.key, isLiveSession);
    if (live !== null && isWaiting(live, this.now())) {
      if (this.deps.isConnected()) pending.push(live);
      live = null;
      // setState only writes what changed against the in-memory state, which is already null here.
      writeString(this.deps.storage, this.key, null);
    }
    this.setState({ live, pending: byStart(pending), waiting: false });
  }

  /** Starts the 1 s ticker and the input listeners; returns the cleanup. */
  start(): () => void {
    this.resume();
    const onInput = (): void => this.noteInput();
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'scroll', 'touchstart'] as const;
    for (const e of events) window.addEventListener(e, onInput, { passive: true, capture: true });
    const timer = window.setInterval(() => this.tick(), 1000);
    return () => {
      window.clearInterval(timer);
      for (const e of events) window.removeEventListener(e, onInput, { capture: true });
    };
  }

  setActivity(patch: Partial<Activity>): void {
    this.activity = { ...this.activity, ...patch };
  }

  noteInput(): void {
    this.lastInputAt = this.perf();
  }

  tick(): void {
    const perfNow = this.perf();
    const studying = isStudying({ ...this.activity, visible: this.visible(), lastInputAt: this.lastInputAt, now: perfNow });
    const seconds = this.ticker.tick(perfNow, studying);
    const now = this.now();
    const ref = this.activity.lectureId === null ? undefined : this.deps.index.byId.get(this.activity.lectureId);
    if (seconds > 0 && ref) {
      this.deps.progress.update((s, t) => withStudy(s, localDateKey(new Date(now)), seconds, t));
      let { live, pending } = this.state;
      // A waiting session from an earlier day is that day's update: it waits for its note on its own.
      if (live !== null && isWaiting(live, now) && localDateKey(new Date(live.startedAt)) !== localDateKey(new Date(now))) {
        if (this.deps.isConnected()) pending = [...pending, live];
        live = null;
      }
      this.setState({ live: accumulate(live, now, seconds, ref.section.number, this.newId), pending, waiting: false });
    } else {
      const waiting = this.state.live !== null && isWaiting(this.state.live, now);
      if (waiting !== this.state.waiting) this.setState({ ...this.state, waiting });
    }
    if (++this.ticks % AUTO_CLOSE_EVERY_TICKS === 0) this.autoClose();
  }

  /** Mark done / not done — also records it in the live session (and sections it finishes). */
  setDone(lectureId: string, done: boolean): void {
    this.deps.progress.update((s, now) => withDone(s, lectureId, done, now));
    const ref = this.deps.index.byId.get(lectureId);
    const live = this.state.live;
    if (live === null || !ref) return;
    const { section, lecture } = ref;
    let next = live;
    if (done) {
      next = addCompleted(next, { section: section.number, lecture: lecture.number, title: lecture.title });
      if (isSectionDone(section, this.deps.progress.get().lectures)) next = addFinishedSection(next, section.number);
    } else {
      next = removeCompleted(next, section.number, lecture.number);
    }
    this.setState({ ...this.state, live: next });
  }

  /** What the sign-off card walks through: earlier sessions (oldest first), then this one. With
   *  nothing unsigned, a note-only update (she studied away from the player). */
  queue(): SignOffTarget[] {
    const out: SignOffTarget[] = this.state.pending.map((session) => ({ kind: 'pending', session }));
    if (this.state.live !== null) out.push({ kind: 'live', session: this.state.live });
    return out.length > 0 ? out : [{ kind: 'note' }];
  }

  /** Quit opens the sign-off card first when this is true. */
  hasUnsigned(): boolean {
    if (!this.deps.isConnected()) return false;
    return this.state.pending.length > 0 || (this.state.live?.seconds ?? 0) >= QUIT_ASKS_FROM_SECONDS;
  }

  /** The sign-off card is asking about these: the 24 h rule must not send them behind her back while she
   *  types (her note would be dropped). Returns the release; skip() releases its target early. */
  hold(targets: readonly SignOffTarget[]): () => void {
    const ids = targets.flatMap((t) => (t.kind === 'note' ? [] : [t.session.id]));
    for (const id of ids) this.held.add(id);
    return () => {
      for (const id of ids) this.held.delete(id);
    };
  }

  /** Sends one update (or nothing: < 5 min with no note, or JS Journey not connected) and clears the
   *  session. 'failed' = the course server did not take it; the session stays for another try. */
  async signOff(target: SignOffTarget, answer: SignOffAnswer): Promise<SignOffResult> {
    // The live session may have grown since the card opened (a video playing behind it): sign off all of it.
    const session = target.kind === 'note' ? null : this.find(target.session.id);
    // Already sent without her (the 24 h rule): a distinct result, so the card tells her instead of
    // advancing as if nothing was lost.
    if (target.kind !== 'note' && session === null) return 'gone';
    const sent = await this.deliver(session, answer, false);
    if (sent === 'failed') return 'failed';
    if (session !== null) this.forget(session.id);
    return sent;
  }

  /** She closed the card on this step without answering. For an earlier session that is "still skips":
   *  it is sent for her once it is older than 24 h. The current session just carries on. */
  skip(target: SignOffTarget): void {
    if (target.kind !== 'pending') return;
    this.held.delete(target.session.id);
    const now = this.now();
    const pending = this.state.pending.map((p) => (p.id === target.session.id && p.skippedAt == null ? { ...p, skippedAt: now } : p));
    this.setState({ ...this.state, pending });
    this.autoClose();
  }

  /** The 24 h rule, for earlier sessions she skipped. Under 5 min (nothing to send) they are dropped.
   *  A no-op until progress has hydrated: the update's snapshot (takenAt = now, so JS Journey keeps it as
   *  the newest) must not come from a cleared browser's empty copy. */
  autoClose(): void {
    if (!this.deps.progress.isHydrated()) return;
    const now = this.now();
    const old = this.state.pending.filter((s) => s.skippedAt != null && now - s.lastStudyAt > PENDING_MAX_AGE_MS && !this.held.has(s.id));
    if (old.length === 0) return;
    // Out of `pending` synchronously, BEFORE the first await: anything reading the queue meanwhile (the
    // at-open card, the header dot, Quit) must not offer a session that is already on its way to Rahul.
    for (const s of old) this.closing.set(s.id, s);
    this.setState({ ...this.state, pending: this.state.pending.filter((p) => !this.closing.has(p.id)) });
    for (const s of old) {
      void this.deliver(s, NO_ANSWER, true).then((result) => {
        this.closing.delete(s.id);
        // not taken: back to pending, retried by the next check
        if (result === 'failed') this.setState({ ...this.state, pending: byStart([...this.state.pending, s]) });
        else this.savePending(this.state.pending);
      });
    }
  }

  private find(id: string): LiveSession | null {
    if (this.state.live?.id === id) return this.state.live;
    return this.state.pending.find((p) => p.id === id) ?? null;
  }

  private async deliver(session: LiveSession | null, answer: SignOffAnswer, autoClosed: boolean): Promise<SignOffResult> {
    if (!this.deps.isConnected()) return 'skipped';
    const snapshot = this.deps.snapshot();
    const update = toUpdate(session, {
      courseId: this.deps.courseId,
      noteId: this.newId(),
      now: this.now(),
      answer,
      autoClosed,
      progress: snapshot,
      fallbackSection: snapshot.current?.sectionNumber ?? this.lastSection(),
    });
    if (update === null) return 'skipped';
    try {
      await this.deps.send(update);
      return 'sent';
    } catch (err) {
      console.error(`[session] ${this.deps.profile}: could not hand update ${update.id} to the course server`, err);
      return 'failed';
    }
  }

  /** A note-only update with no current lecture (every lecture done): the section she was last in, else
   *  the course's last one. Never 0 — JS Journey 400s it and the outbox drops the update, note and all. */
  private lastSection(): number {
    const last = this.deps.progress.get().lastLectureId;
    const ref = (last === null ? undefined : this.deps.index.byId.get(last)) ?? this.deps.index.byId.get(this.deps.index.order.at(-1) ?? '');
    return ref?.section.number ?? 1;
  }

  private forget(id: string): void {
    const live = this.state.live?.id === id ? null : this.state.live;
    const pending = this.state.pending.filter((p) => p.id !== id);
    this.setState({ live, pending, waiting: live === null ? false : this.state.waiting });
  }

  private setState(next: StudyState): void {
    const prev = this.state;
    if (next.live === prev.live && next.pending === prev.pending && next.waiting === prev.waiting) return;
    this.state = next;
    if (next.live !== prev.live) {
      if (next.live === null) writeString(this.deps.storage, this.key, null);
      else writeJson(this.deps.storage, this.key, next.live);
    }
    if (next.pending !== prev.pending) this.savePending(next.pending);
    for (const cb of this.listeners) cb();
  }

  /** Stored = `pending` + the auto-closes still in flight (see `closing`). */
  private savePending(pending: PendingSession[]): void {
    const all = byStart([...pending, ...this.closing.values()]);
    if (all.length === 0) writeString(this.deps.storage, this.pendingKey, null);
    else writeJson(this.deps.storage, this.pendingKey, all);
  }
}

export const StudyContext = createContext<StudyController | null>(null);

export function useStudy(): StudyController {
  const study = useContext(StudyContext);
  if (study === null) throw new Error('useStudy outside <StudyContext>');
  return study;
}

export function useStudyState(): StudyState {
  const study = useStudy();
  return useSyncExternalStore(study.subscribe, study.getState);
}

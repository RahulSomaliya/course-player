// The study timer + sign-offs (docs/spec-v3-study-timer.md A3–A5). One session at most, a WALL-CLOCK
// timer from "Start studying" (or a lecture she plays / opens: auto-start) until she presses Send —
// whatever she does meanwhile (coding, GitHub, nothing). It is persisted (`cp:<course>:<profile>:study`)
// and keeps running through reloads, closed tabs, a stopped server and app restarts.
//
// That key is the ONE truth for the session, shared by every window of the app: a 2nd launcher
// double-click opens a 2nd tab, and closing the Terminal leaves the old tab open. Every action re-reads it
// first (adopt), other windows follow it on `storage` / `focus`, and an action never writes over a session
// that ended or changed elsewhere. Review 2026-10-05: each tab read it once, at open — the stale tab's chip
// kept ticking after the other tab sent the session, she signed off there too, JS Journey answered
// "duplicate" for the same id and stored nothing while the card said "Sent to Rahul ✓ · note included"
// (her 2nd note lost, her days credited twice), and the stale tab wrote the sent session back.
//
// Never again a silent loss (2026-10-05: her sign-off vanished). So:
// - Send hands the update to the local server's outbox (POST sessions, 202 = saved there, connected or
//   not). Only then does the timer stop and her study time get credited — a failed hand-over keeps the
//   session running and says so. Whether it reached Rahul is the OUTBOX's answer, read by the card
//   (state/journey.ts awaitDelivery), never assumed from the 202.
// - Nothing sends or ends a session by itself: v2's 20-min "waiting", `pending` sittings and 24 h
//   auto-close are gone. Leftover v2 sessions are sent once as recorded (migrateLegacy, lib/legacy.ts).
// - Daily study time (ProgressState.days) is credited ONLY here, at sign-off, from the minutes she sends
//   (lib/session.ts splitAcrossDays). The 1 s ticker below no longer writes days — it would double-count;
//   it only measures WHERE she studies (sectionSeconds → the update's section).
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { JourneySession, ProgressSnapshot, ProgressState } from '../../../shared/types';
import type { CourseIndex } from '../lib/course';
import { isSectionDone } from '../lib/course';
import { LEGACY_MIN_SECONDS, legacyUpdate, readLegacy } from '../lib/legacy';
import { withDone, withStudyDays } from '../lib/progress';
import {
  addCompleted,
  addFinishedSection,
  addSectionTime,
  canSend,
  isStudySession,
  liveDays,
  newSession,
  removeCompleted,
  sendableMinutes,
  splitAcrossDays,
  toUpdate,
  type SignOffAnswer,
  type StudySession,
} from '../lib/session';
import { ApiError } from '../lib/api';
import { writeString, type KeyValueStore } from '../lib/storage';
import { StudyTicker, isStudying } from '../lib/ticker';
import { useProgress, type ProgressStore } from './progress';

/** v3's key. NOT v2's `…:session`: that held a different shape (lib/legacy.ts reads it once). */
export const studyKey = (courseId: string, profile: string): string => `cp:${courseId}:${profile}:study`;

/** player time per section is committed to the session this often (ticks ≈ seconds): it only picks the
 *  update's section, and committing every second re-rendered every subscriber and rewrote localStorage */
const SECTION_FLUSH_TICKS = 15;

export interface StudyState {
  session: StudySession | null;
  /** the latest auto-start: the header says "Study timer started" for a few seconds after `at` */
  notice: { at: number } | null;
}

/** ok = in the local outbox (NOT "sent to Rahul" — see the header); else why not, in her words.
 *  `alreadyDelivered`: the server refused it (409) because JS Journey already has this update's id. */
export type HandOver = { ok: true; update: JourneySession } | { ok: false; error: string; alreadyDelivered: boolean };

export interface Activity {
  lectureId: string | null;
  playing: boolean;
  reading: boolean;
}

export interface StudyDeps {
  courseId: string;
  /** BootPayload.folderCourseId — v2 keys may sit under it (the id used to be the folder slug) */
  legacyCourseId: string;
  profile: string;
  progress: ProgressStore;
  index: CourseIndex;
  storage: KeyValueStore | null;
  /** hands an update to the local server's outbox: resolves on its 202 (connected or not — v3) */
  send: (update: JourneySession) => Promise<unknown>;
  /** her progress — of `state` when given: an update carries the days its own sign-off credits */
  snapshot: (state?: ProgressState) => ProgressSnapshot;
  clock?: { now: () => number; perf: () => number };
  isVisible?: () => boolean;
  newId?: () => string;
}

const NOT_HANDED = 'Couldn’t hand it to the course app — is it still running? Try again.';
/** signOff refused: the session the card shows was sent or discarded in another window of the app */
export const SESSION_ENDED_ELSEWHERE = 'This session already ended in another window — nothing was sent from here.';

/** A stored session, or undefined when the value is not one (hand-edited, half-written). */
function parseSession(raw: string): StudySession | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isStudySession(parsed) ? parsed : undefined;
  } catch {
    return undefined; // not JSON: the caller reports it
  }
}

export class StudyController {
  private state: StudyState = { session: null, notice: null };
  private activity: Activity = { lectureId: null, playing: false, reading: false };
  private lastInputAt: number;
  private ticks = 0;
  /** the v2 → v3 migration in flight: StrictMode runs App's effect twice, and two runs POSTed every v2
   *  session twice (harmless — same ids — but each one a needless request and log line) */
  private migration: Promise<number> | null = null;
  /** section number → player seconds not yet committed to the session (SECTION_FLUSH_TICKS) */
  private readonly carry = new Map<number, number>();
  private readonly ticker: StudyTicker;
  private readonly listeners = new Set<() => void>();
  /** the key's value as this window last read or wrote it; undefined = not read yet. Another window
   *  changed the session when the key no longer holds it (adopt). */
  private lastRaw: string | null | undefined = undefined;
  /** false while this window's last write of the session failed (full / blocked storage): the key then
   *  holds an older value, and adopting it would drop the running session */
  private persisted = true;
  private readonly key: string;
  private readonly now: () => number;
  private readonly perf: () => number;
  private readonly visible: () => boolean;
  private readonly newId: () => string;

  constructor(private readonly deps: StudyDeps) {
    this.key = studyKey(deps.courseId, deps.profile);
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

  /** App open: the running session, if any — it kept running while the app was closed. */
  resume(): void {
    this.adopt();
  }

  /** Starts the 1 s ticker, the input listeners and the other-window sync; returns the cleanup. */
  start(): () => void {
    this.resume();
    const onInput = (): void => this.noteInput();
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'scroll', 'touchstart'] as const;
    for (const e of events) window.addEventListener(e, onInput, { passive: true, capture: true });
    // `storage` fires in every OTHER window of this origin when one changes the key (null key = clear());
    // focus re-reads too, for a window that missed it (e.g. it was frozen in the background)
    const onStorage = (e: StorageEvent): void => {
      if (e.key === this.key || e.key === null) this.adopt();
    };
    const onFocus = (): void => this.adopt();
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(() => this.tick(), 1000);
    return () => {
      window.clearInterval(timer);
      for (const e of events) window.removeEventListener(e, onInput, { capture: true });
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', onFocus);
      this.flushSectionTime();
    };
  }

  setActivity(patch: Partial<Activity>): void {
    this.activity = { ...this.activity, ...patch };
  }

  noteInput(): void {
    this.lastInputAt = this.perf();
  }

  /** Measures WHERE she studies (never how long — that is the wall clock). */
  tick(): void {
    const perfNow = this.perf();
    const studying = isStudying({ ...this.activity, visible: this.visible(), lastInputAt: this.lastInputAt, now: perfNow });
    const seconds = this.ticker.tick(perfNow, studying);
    const ref = this.activity.lectureId === null ? undefined : this.deps.index.byId.get(this.activity.lectureId);
    if (seconds > 0 && ref && this.state.session !== null) {
      const n = ref.section.number;
      this.carry.set(n, (this.carry.get(n) ?? 0) + seconds);
    }
    if (++this.ticks % SECTION_FLUSH_TICKS === 0) this.flushSectionTime();
  }

  /** "Start studying" (home + header). A running session — this window's or another's — is left as it is. */
  startSession(): void {
    this.adopt();
    if (this.state.session !== null) return;
    this.carry.clear();
    this.set({ ...this.state, session: newSession(this.newId(), this.now(), false) });
  }

  /** A lecture was played / opened with no session running: start one, and say so quietly (header). */
  autoStart(): void {
    this.adopt();
    if (this.state.session !== null) return;
    this.carry.clear();
    const now = this.now();
    this.set({ session: newSession(this.newId(), now, true), notice: { at: now } });
  }

  /** Mark done / not done — also recorded in the running session (and the sections it finishes). */
  setDone(lectureId: string, done: boolean): void {
    this.deps.progress.update((s, now) => withDone(s, lectureId, done, now));
    const ref = this.deps.index.byId.get(lectureId);
    this.adopt();
    const s = this.state.session;
    if (s === null || !ref) return;
    const { section, lecture } = ref;
    let next = s;
    if (done) {
      next = addCompleted(next, { section: section.number, lecture: lecture.number, title: lecture.title });
      if (isSectionDone(section, this.deps.progress.get().lectures)) next = addFinishedSection(next, section.number);
    } else {
      next = removeCompleted(next, section.number, lecture.number);
    }
    this.set({ ...this.state, session: next });
  }

  /**
   * Send to Rahul — `sessionId` = the session the card shows. Her minutes (never above the timer — the
   * card caps it too) are credited to the days the session spanned, and the update carries that progress.
   * The timer stops only once the local outbox has the update: a failed hand-over keeps the session (and
   * credits nothing), so she can retry. A session that ended in another window (the key no longer holds
   * it) is refused, never sent again: see the header.
   */
  async signOff(sessionId: string, answer: SignOffAnswer): Promise<HandOver> {
    this.flushSectionTime(); // adopts first
    const s = this.state.session;
    if (s === null || s.id !== sessionId) return { ok: false, error: SESSION_ENDED_ELSEWHERE, alreadyDelivered: false };
    const now = this.now();
    const minutes = Math.min(Math.max(0, Math.floor(answer.minutes)), sendableMinutes(s, now));
    if (!canSend(minutes, answer.note)) return { ok: false, error: 'Add the time you studied, or a note.', alreadyDelivered: false };
    const credit = splitAcrossDays(s.startedAt, now, minutes * 60);
    const update = this.build(s, { ...answer, minutes }, now, withStudyDays(this.deps.progress.get(), credit, now));
    if (update === null) return { ok: false, error: 'Add the time you studied, or a note.', alreadyDelivered: false };
    const handed = await this.handOver(update);
    this.adopt(); // another window may have ended it, or started a new one, during the POST
    if (!handed.ok) return handed;
    this.deps.progress.update((p, t) => withStudyDays(p, credit, t));
    // a session started meanwhile in another window is not this one: only clear what was sent
    if (this.state.session?.id === s.id) {
      this.carry.clear();
      this.set({ ...this.state, session: null });
    }
    return handed;
  }

  /** "Note to Rahul…": a note-only update (no time, note required). A running timer is left alone. */
  async sendNote(answer: SignOffAnswer): Promise<HandOver> {
    const update = this.build(null, { ...answer, minutes: 0 }, this.now(), undefined);
    if (update === null) return { ok: false, error: 'Write a note for Rahul.', alreadyDelivered: false };
    return this.handOver(update);
  }

  /** "Try again" on the card after JS Journey refused it: the same update (same id — the server takes a
   *  rejected id back into its queue) with her edits. Its study time was credited at the first Send. */
  resend(update: JourneySession): Promise<HandOver> {
    return this.handOver(update);
  }

  /** An accidental session (`sessionId`, the one the card shows): gone, nothing sent, no study time
   *  credited. A session started in another window since is left alone. */
  discard(sessionId: string): void {
    this.adopt();
    if (this.state.session?.id !== sessionId) return;
    this.carry.clear();
    this.set({ ...this.state, session: null });
  }

  /**
   * v2 → v3, once per browser (lib/legacy.ts): every v2 session ≥ 1 min goes to the outbox as recorded
   * (autoClosed, no note); the keys are removed only after the server took them all — otherwise the next
   * open tries again (same ids: the outbox replaces, JS Journey dedups). Waits for hydrate: the updates'
   * snapshot must come from the SSD copy, never a cleared browser's empty one (2026-10-01 review).
   * Returns how many went to the outbox. Concurrent calls share one run.
   */
  migrateLegacy(): Promise<number> {
    this.migration ??= this.migrate().finally(() => {
      this.migration = null;
    });
    return this.migration;
  }

  private async migrate(): Promise<number> {
    const courseIds = [this.deps.courseId, this.deps.legacyCourseId];
    const { sessions, keys } = readLegacy(this.deps.storage, courseIds, this.deps.profile);
    if (keys.length === 0) return 0;
    let sent = 0;
    await this.deps.progress.hydrate();
    const snapshot = this.deps.snapshot();
    const fallbackSection = snapshot.current?.sectionNumber ?? this.lastSection();
    for (const s of sessions) {
      if (s.seconds < LEGACY_MIN_SECONDS) {
        console.warn(`[study] ${this.deps.profile}: v2 session ${s.id} has ${s.seconds} s — under a minute, nothing to send`);
        continue;
      }
      const handed = await this.handOver(legacyUpdate(s, { courseId: this.deps.courseId, progress: snapshot, fallbackSection }));
      // already with Rahul (an earlier run delivered it; this run's body differs — e.g. its fallback
      // section moved): done. Stopping here would strand every v2 session after it.
      if (!handed.ok && handed.alreadyDelivered) continue;
      if (!handed.ok) return sent; // keys kept: the next open sends them again
      sent++;
    }
    for (const key of keys) writeString(this.deps.storage, key, null);
    return sent;
  }

  private build(s: StudySession | null, answer: SignOffAnswer, now: number, state: ProgressState | undefined): JourneySession | null {
    const snapshot = this.deps.snapshot(state);
    return toUpdate(s, {
      courseId: this.deps.courseId,
      noteId: this.newId(),
      now,
      answer,
      progress: snapshot,
      fallbackSection: snapshot.current?.sectionNumber ?? this.lastSection(),
    });
  }

  private async handOver(update: JourneySession): Promise<HandOver> {
    try {
      await this.deps.send(update);
      return { ok: true, update };
    } catch (err) {
      console.error(`[study] ${this.deps.profile}: could not hand update ${update.id} to the course server`, err);
      // 409 = it took the request and refused it for a reason in her words (server/journey.ts enqueue:
      // a changed copy of an update JS Journey already has) — "is it still running?" would be wrong
      const already = err instanceof ApiError && err.status === 409;
      return { ok: false, error: already ? err.message : NOT_HANDED, alreadyDelivered: already };
    }
  }

  /** No current lecture (every lecture done): the section she was last in, else the course's last one.
   *  Never 0 — JS Journey 400s it. */
  private lastSection(): number {
    const last = this.deps.progress.get().lastLectureId;
    const ref = (last === null ? undefined : this.deps.index.byId.get(last)) ?? this.deps.index.byId.get(this.deps.index.order.at(-1) ?? '');
    return ref?.section.number ?? 1;
  }

  private flushSectionTime(): void {
    this.adopt();
    const s = this.state.session;
    if (this.carry.size === 0 || s === null) return;
    let next = s;
    for (const [section, seconds] of this.carry) next = addSectionTime(next, section, seconds);
    this.carry.clear();
    this.set({ ...this.state, session: next });
  }

  /**
   * Takes the session as the key holds it NOW (see the header): another window may have sent, discarded,
   * started or changed it since this one last looked. Never writes. Every action calls it before it reads
   * this.state.session, so what it then writes is built on the current session, never on a stale copy.
   */
  private adopt(): void {
    const store = this.deps.storage;
    if (store === null || !this.persisted) return; // memory only: no other window can see this session
    let raw: string | null;
    try {
      raw = store.getItem(this.key);
    } catch (err) {
      // unreadable is not "gone": keep this window's session rather than drop a running timer
      console.warn(`[study] ${this.key}: could not read the study session — keeping this window's`, err);
      return;
    }
    if (raw === this.lastRaw) return;
    this.lastRaw = raw;
    const session = raw === null ? null : parseSession(raw);
    if (session === undefined) {
      console.warn(`[study] ${this.key}: unreadable study session — ignored`);
      return;
    }
    // player time measured for a session that ended elsewhere belongs to no session
    if (session?.id !== this.state.session?.id) this.carry.clear();
    this.state = { ...this.state, session };
    for (const cb of this.listeners) cb();
  }

  private set(next: StudyState): void {
    const prev = this.state;
    if (next.session === prev.session && next.notice === prev.notice) return;
    this.state = next;
    if (next.session !== prev.session) this.save(next.session);
    for (const cb of this.listeners) cb();
  }

  private save(session: StudySession | null): void {
    if (this.deps.storage === null) return;
    const raw = session === null ? null : JSON.stringify(session);
    this.persisted = writeString(this.deps.storage, this.key, raw);
    if (this.persisted) this.lastRaw = raw;
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

/** Date.now(), refreshed every `everyMs` while `active` (the running timer: "at least every 30 s"). */
export function useNow(active: boolean, everyMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(t);
  }, [active, everyMs]);
  return now;
}

/** ProgressState.days + the running timer (display only: Today, the streak, the 30-day chart). */
export function useStudyDays(): Record<string, number> {
  const days = useProgress((s) => s.days);
  const { session } = useStudyState();
  const now = useNow(session !== null);
  return useMemo(() => (session === null ? days : liveDays(days, session, now)), [days, session, now]);
}

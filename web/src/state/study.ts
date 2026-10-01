// Drives study time + study sessions (spec "Study time", "Study sessions"). The player and the article
// view report what is open/playing via setActivity; a 1 s interval credits studied seconds to
// ProgressState.days and to the live session; 20 min without studying ends the session silently.
// The live session is persisted (`cp:<course>:<profile>:session`) so a reload continues it; an ended
// session waiting for its wrap-up card is persisted too (`…:wrap`) until it has been posted.
import { createContext, useContext, useSyncExternalStore } from 'react';
import type { JourneySession } from '../../../shared/types';
import type { CourseIndex } from '../lib/course';
import { isSectionDone } from '../lib/course';
import { localDateKey } from '../lib/dates';
import { withDone, withStudy } from '../lib/progress';
import {
  MIN_SEND_SECONDS,
  accumulate,
  addCompleted,
  addFinishedSection,
  isIdle,
  isLiveSession,
  removeCompleted,
  toJourneySession,
  type LiveSession,
  type Mood,
} from '../lib/session';
import { readJson, writeJson, writeString, type KeyValueStore } from '../lib/storage';
import { StudyTicker, isStudying } from '../lib/ticker';
import type { ProgressStore } from './progress';

export const sessionKey = (courseId: string, profile: string): string => `cp:${courseId}:${profile}:session`;
/** An ended session whose wrap-up card is not answered yet (see endSession). */
export const wrapKey = (courseId: string, profile: string): string => `cp:${courseId}:${profile}:wrap`;

interface PendingWrap {
  session: LiveSession;
  endedAt: number;
}

function isPendingWrap(x: unknown): x is PendingWrap {
  if (typeof x !== 'object' || x === null) return false;
  const w = x as Record<string, unknown>;
  return isLiveSession(w.session) && typeof w.endedAt === 'number' && Number.isFinite(w.endedAt);
}

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
  clock?: { now: () => number; perf: () => number };
  isVisible?: () => boolean;
  newId?: () => string;
}

export class StudyController {
  private session: LiveSession | null = null;
  private activity: Activity = { lectureId: null, playing: false, reading: false };
  private lastInputAt: number;
  private readonly ticker: StudyTicker;
  private readonly listeners = new Set<() => void>();
  private readonly key: string;
  private readonly wrapKey: string;
  private readonly now: () => number;
  private readonly perf: () => number;
  private readonly visible: () => boolean;
  private readonly newId: () => string;

  constructor(private readonly deps: StudyDeps) {
    this.key = sessionKey(deps.courseId, deps.profile);
    this.wrapKey = wrapKey(deps.courseId, deps.profile);
    this.now = deps.clock?.now ?? Date.now;
    this.perf = deps.clock?.perf ?? (() => performance.now());
    this.visible = deps.isVisible ?? (() => document.visibilityState === 'visible');
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.lastInputAt = this.perf();
    this.ticker = new StudyTicker(this.perf());
  }

  getSession = (): LiveSession | null => this.session;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  /** App open: post a wrap-up the last page never answered, then continue a stored session, or
   *  finalize it silently when it has been idle > 20 min. */
  resume(): void {
    this.sendPendingWrap();
    const stored = readJson(this.deps.storage, this.key, isLiveSession);
    if (stored === null) return;
    if (isIdle(stored, this.now())) {
      writeString(this.deps.storage, this.key, null);
      void this.send(stored, { mood: null, note: null, endedAt: stored.lastStudyAt });
      return;
    }
    this.setSession(stored);
  }

  /** Starts the 1 s ticker and the input/visibility listeners; returns the cleanup. */
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
      this.setSession(accumulate(this.session, now, seconds, ref.section.number, this.newId));
      return;
    }
    if (this.session !== null && isIdle(this.session, now)) {
      const ended = this.session;
      this.setSession(null);
      void this.send(ended, { mood: null, note: null, endedAt: ended.lastStudyAt });
    }
  }

  /** Mark done / not done — also records it in the live session (and sections it finishes). */
  setDone(lectureId: string, done: boolean): void {
    this.deps.progress.update((s, now) => withDone(s, lectureId, done, now));
    const ref = this.deps.index.byId.get(lectureId);
    if (this.session === null || !ref) return;
    const { section, lecture } = ref;
    let next = this.session;
    if (done) {
      next = addCompleted(next, { section: section.number, lecture: lecture.number, title: lecture.title });
      if (isSectionDone(section, this.deps.progress.get().lectures)) next = addFinishedSection(next, section.number);
    } else {
      next = removeCompleted(next, section.number, lecture.number);
    }
    this.setSession(next);
  }

  /** "End session" / Quit: stops the live session and hands back its snapshot for the wrap-up card.
   *  WHY the `wrap` key: setSession(null) removes the persisted live session, and the card's answer
   *  lives only in React state — closing the tab/browser/lid while the card shows (natural right after
   *  Quit) used to lose a >= 5 min session for good. It stays stored until send() delivers it;
   *  pagehide (App.tsx) and the next app open (resume) post it as Skip would. */
  endSession(): LiveSession | null {
    const ended = this.session;
    if (ended !== null && this.needsWrapUp(ended)) writeJson(this.deps.storage, this.wrapKey, { session: ended, endedAt: this.now() });
    this.setSession(null);
    return ended;
  }

  /** pagehide / app open: post an unanswered wrap-up with mood/note null (Skip). JS Journey dedups on
   *  session.id, so a page that survives pagehide (bfcache) and then gets Send pressed is harmless. */
  sendPendingWrap(): void {
    const pending = readJson(this.deps.storage, this.wrapKey, isPendingWrap);
    if (pending !== null) void this.send(pending.session, { mood: null, note: null, endedAt: pending.endedAt });
  }

  /** The wrap-up card shows for journey-connected profiles and sessions that will be sent (≥ 5 min). */
  needsWrapUp(s: LiveSession | null): boolean {
    return s !== null && s.seconds >= MIN_SEND_SECONDS && this.deps.isConnected();
  }

  /** Posts the session to the local server (which queues it for JS Journey). Never throws.
   *  A pending wrap-up for this session is cleared once it is delivered (or can never be sent);
   *  a failed POST keeps it for the next app open. */
  async send(s: LiveSession, opts: { mood: Mood | null; note: string | null; endedAt: number }): Promise<boolean> {
    const journey = this.deps.isConnected() ? toJourneySession(s, { courseId: this.deps.courseId, ...opts }) : null;
    if (journey === null) {
      this.clearWrap(s.id);
      return false;
    }
    try {
      await this.deps.send(journey);
      this.clearWrap(s.id);
      return true;
    } catch (err) {
      console.error(`[session] ${this.deps.profile}: could not hand session ${s.id} to the course server`, err);
      return false;
    }
  }

  private clearWrap(sessionId: string): void {
    const pending = readJson(this.deps.storage, this.wrapKey, isPendingWrap);
    if (pending !== null && pending.session.id === sessionId) writeString(this.deps.storage, this.wrapKey, null);
  }

  private setSession(next: LiveSession | null): void {
    if (next === this.session) return;
    this.session = next;
    if (next === null) writeString(this.deps.storage, this.key, null);
    else writeJson(this.deps.storage, this.key, next);
    for (const cb of this.listeners) cb();
  }
}

export const StudyContext = createContext<StudyController | null>(null);

export function useStudy(): StudyController {
  const study = useContext(StudyContext);
  if (study === null) throw new Error('useStudy outside <StudyContext>');
  return study;
}

export function useLiveSession(): LiveSession | null {
  const study = useStudy();
  return useSyncExternalStore(study.subscribe, study.getSession);
}

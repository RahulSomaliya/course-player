import { describe, expect, it, vi } from 'vitest';
import type { JourneySession, ProgressSnapshot } from '../../../shared/types';
import { indexCourse } from '../lib/course';
import { localDateKey } from '../lib/dates';
import { PENDING_MAX_AGE_MS, SESSION_IDLE_MS, type LiveSession, type SignOffAnswer } from '../lib/session';
import { withLast } from '../lib/progress';
import type { KeyValueStore } from '../lib/storage';
import { sampleCourse } from '../lib/test-fixtures';
import { ProgressStore } from './progress';
import { StudyController, legacyWrapKey, pendingKey, sessionKey } from './study';

function memoryStore(init: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

const course = sampleCourse();
const ids = course.sections.flatMap((s) => s.lectures.map((l) => l.id));
const id = (i: number): string => ids[i] as string;
const SNAP: ProgressSnapshot = {
  course: course.id,
  takenAt: 0,
  lecturesDone: 0,
  lecturesTotal: 7,
  videoSecondsDone: 0,
  videoSecondsTotal: 4260,
  sectionsDone: [],
  current: { sectionNumber: 3, lectureNumber: 1, title: 'Props' },
  days: {},
};
const noAnswer: SignOffAnswer = { mood: null, note: null, stuck: false };
const settle = () => new Promise((r) => setTimeout(r, 0));

type Opts = {
  connected?: boolean;
  storage?: KeyValueStore & { data: Map<string, string> };
  send?: (s: JourneySession) => Promise<unknown>;
  start?: Date;
  snapshot?: ProgressSnapshot;
};

function setup(opts: Opts = {}) {
  const storage = opts.storage ?? memoryStore();
  let epoch = (opts.start ?? new Date(2026, 9, 1, 19, 0)).getTime();
  let perf = 0;
  let n = 0;
  const progress = new ProgressStore({
    courseId: course.id,
    profile: 'mansi',
    storage,
    api: { get: async () => null, put: async () => undefined },
    now: () => epoch,
  });
  const sent: JourneySession[] = [];
  const study = new StudyController({
    courseId: course.id,
    profile: 'mansi',
    progress,
    index: indexCourse(course),
    storage,
    isConnected: () => opts.connected ?? true,
    send: opts.send ?? (async (s) => void sent.push(s)),
    snapshot: () => opts.snapshot ?? SNAP,
    clock: { now: () => epoch, perf: () => perf },
    isVisible: () => true,
    newId: () => `session-${++n}`,
  });
  const advance = (seconds: number, tick = true): void => {
    for (let i = 0; i < seconds; i++) {
      epoch += 1000;
      perf += 1000;
      if (tick) study.tick();
    }
  };
  /** jump the wall clock without ticking (laptop asleep / app closed) */
  const jump = (ms: number): void => {
    epoch += ms;
    perf += ms;
  };
  const play = (lecture: number, seconds: number): void => {
    study.setActivity({ lectureId: id(lecture), playing: true, reading: false });
    advance(seconds);
    study.setActivity({ playing: false });
  };
  /** App.tsx's open order: resume, the SSD copy is read (hydrate), then the 24 h rule */
  const open = async (): Promise<void> => {
    study.resume();
    await progress.hydrate();
    study.autoClose();
  };
  return { study, progress, storage, sent, advance, jump, play, open, epoch: () => epoch };
}

const stale = (over: Partial<LiveSession> = {}): LiveSession => ({
  id: 'old',
  startedAt: new Date(2026, 8, 29, 20, 0).getTime(), // Tue evening
  lastStudyAt: new Date(2026, 8, 29, 21, 12).getTime(),
  seconds: 72 * 60,
  sectionSeconds: { 3: 72 * 60 },
  lecturesCompleted: [],
  finishedSections: [],
  ...over,
});

describe('StudyController: study time', () => {
  it('a playing video adds study time to today and starts a session in its section', () => {
    const { study, progress, advance, epoch } = setup();
    study.setActivity({ lectureId: id(5), playing: true, reading: false });
    advance(90);
    expect(progress.get().days[localDateKey(new Date(epoch()))]).toBe(90);
    expect(study.getState().live).toMatchObject({ seconds: 90, sectionSeconds: { 3: 90 } });
  });

  it('nothing open → no study time, no session', () => {
    const { study, progress, advance } = setup();
    advance(30);
    expect(progress.get().days).toEqual({});
    expect(study.getState().live).toBeNull();
  });

  it('an article counts only while there was input in the last 3 min', () => {
    const { study, progress, advance, epoch } = setup();
    study.setActivity({ lectureId: id(4), playing: false, reading: true });
    study.noteInput();
    advance(200);
    expect(progress.get().days[localDateKey(new Date(epoch()))]).toBe(180);
  });

  it('persists the live session so a reload continues it', () => {
    const storage = memoryStore();
    setup({ storage }).play(0, 60);
    const b = setup({ storage });
    b.study.resume();
    expect(b.study.getState().live?.seconds).toBe(60);
    expect(b.study.getState().pending).toEqual([]);
  });

  it('records lectures completed and sections finished during the session', () => {
    const { study, advance } = setup();
    study.setActivity({ lectureId: id(0), playing: true, reading: false });
    advance(10);
    study.setDone(id(0), true);
    study.setDone(id(1), true);
    study.setDone(id(2), true);
    expect(study.getState().live?.lecturesCompleted.map((l) => l.lecture)).toEqual([1, 2, 3]);
    expect(study.getState().live?.finishedSections).toEqual([1]);
    study.setDone(id(2), false);
    expect(study.getState().live?.lecturesCompleted.map((l) => l.lecture)).toEqual([1, 2]);
  });

  it('marking done with no session running only changes progress', () => {
    const { study, progress } = setup();
    study.setDone(id(0), true);
    expect(progress.get().lectures[id(0)]?.done).toBe(true);
    expect(study.getState().live).toBeNull();
  });
});

describe('StudyController: idle no longer sends anything (v2)', () => {
  it('20 min without studying: nothing is sent, the session stops growing and waits (header dot)', () => {
    const { study, sent, advance, play } = setup();
    play(5, 6 * 60);
    expect(study.getState().waiting).toBe(false);
    advance(SESSION_IDLE_MS / 1000 + 2);
    expect(sent).toHaveLength(0);
    expect(study.getState()).toMatchObject({ waiting: true, live: { seconds: 6 * 60 } });
  });

  it('studying again the same day continues the same session', () => {
    const { study, advance, play } = setup();
    play(5, 6 * 60);
    advance(SESSION_IDLE_MS / 1000 + 60);
    play(5, 60);
    expect(study.getState()).toMatchObject({ waiting: false, pending: [], live: { id: 'session-1', seconds: 7 * 60 } });
  });

  it('studying again on another day: the earlier session waits for its note, a new one starts', () => {
    const { study, jump, advance, play } = setup();
    play(5, 30 * 60);
    jump(14 * 3_600_000); // next morning, app left open
    advance(1); // the first tick after a sleep is capped at 5 s (lib/ticker.ts); nothing plays here
    play(5, 60);
    const { live, pending } = study.getState();
    expect(pending.map((s) => [s.id, s.seconds])).toEqual([['session-1', 1800]]);
    expect(live).toMatchObject({ id: 'session-2', seconds: 60 });
  });
});

describe('StudyController: the next app open', () => {
  it('a stored session idle > 20 min becomes a pending one (the card asks for its note)', () => {
    const storage = memoryStore({ [sessionKey(course.id, 'mansi')]: JSON.stringify(stale()) });
    const { study, sent } = setup({ storage, start: new Date(2026, 8, 30, 9, 0) });
    study.resume();
    expect(sent).toHaveLength(0);
    expect(study.getState()).toMatchObject({ live: null, pending: [{ id: 'old' }] });
    expect(storage.data.has(sessionKey(course.id, 'mansi'))).toBe(false);
    expect(JSON.parse(storage.data.get(pendingKey(course.id, 'mansi')) ?? '[]')).toHaveLength(1);
    expect(study.queue().map((t) => t.kind)).toEqual(['pending']);
  });

  it('without JS Journey a stale session is simply dropped (it still counts in local stats)', () => {
    const storage = memoryStore({ [sessionKey(course.id, 'mansi')]: JSON.stringify(stale()) });
    const { study } = setup({ storage, connected: false, start: new Date(2026, 8, 30, 9, 0) });
    study.resume();
    expect(study.getState()).toMatchObject({ live: null, pending: [] });
  });

  it('an earlier session older than 24 h she has not been asked about yet is NOT sent: the card asks first', async () => {
    const storage = memoryStore({ [sessionKey(course.id, 'mansi')]: JSON.stringify(stale()) });
    const { study, sent, open } = setup({ storage, start: new Date(stale().lastStudyAt + 2 * PENDING_MAX_AGE_MS) });
    await open();
    await settle();
    expect(sent).toHaveLength(0);
    expect(study.getState().pending.map((p) => p.id)).toEqual(['old']);
  });

  it('closing the card on an earlier session older than 24 h ("she still skips") sends it: autoClosed true', async () => {
    const storage = memoryStore({ [pendingKey(course.id, 'mansi')]: JSON.stringify([stale()]) });
    const { study, sent, open } = setup({ storage, start: new Date(stale().lastStudyAt + PENDING_MAX_AGE_MS + 60_000) });
    await open();
    study.skip(study.queue()[0]!);
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ id: 'old', minutes: 72, autoClosed: true, mood: null, note: null, stuck: false, progress: SNAP });
    expect(study.getState().pending).toEqual([]);
  });

  it('a skipped session younger than 24 h waits (dot) and is sent once it crosses 24 h — on open or while open', async () => {
    const storage = memoryStore({ [pendingKey(course.id, 'mansi')]: JSON.stringify([stale()]) });
    const { study, sent, jump, advance, open } = setup({ storage, start: new Date(stale().lastStudyAt + 3_600_000) });
    await open();
    study.skip(study.queue()[0]!);
    await settle();
    expect(sent).toHaveLength(0);
    expect(study.getState().pending[0]?.skippedAt).not.toBeNull();
    jump(PENDING_MAX_AGE_MS);
    advance(61); // the rule is checked about once a minute
    await settle();
    expect(sent.map((s) => [s.id, s.autoClosed])).toEqual([['old', true]]);
  });

  it('skipping the CURRENT session changes nothing (it keeps growing; Quit/Sign off ask again)', async () => {
    const { study, sent, play } = setup();
    play(5, 600);
    study.skip(study.queue()[0]!);
    await settle();
    expect(sent).toHaveLength(0);
    expect(study.getState().live?.seconds).toBe(600);
  });

  it('the 24 h rule drops a skipped session under 5 min instead of sending it', async () => {
    const storage = memoryStore({ [pendingKey(course.id, 'mansi')]: JSON.stringify([{ ...stale({ seconds: 120 }), skippedAt: stale().lastStudyAt }]) });
    const { study, sent, open } = setup({ storage, start: new Date(stale().lastStudyAt + PENDING_MAX_AGE_MS + 60_000) });
    await open();
    await settle();
    expect(sent).toHaveLength(0);
    expect(study.getState().pending).toEqual([]);
  });

  // Review 2026-10-01 (high): the auto-close POST started inside resume() while the session stayed in
  // `pending`, so the at-open card asked about it too — her note then went nowhere ('skipped'), or the
  // same id went out twice and JS Journey deduped her note away.
  it('the second open after a skip: a session over 24 h is sent for her at open and never asked about again', async () => {
    const skipped = { ...stale(), skippedAt: new Date(2026, 8, 30, 9, 0).getTime() }; // Tue's session, card closed Wed
    const storage = memoryStore({ [pendingKey(course.id, 'mansi')]: JSON.stringify([skipped]) });
    let release: () => void = () => undefined;
    const sent: JourneySession[] = [];
    const send = (s: JourneySession): Promise<void> => {
      sent.push(s);
      return new Promise<void>((r) => {
        release = r;
      });
    };
    const { study, open } = setup({ storage, send, start: new Date(2026, 9, 1, 19, 0) }); // Thu evening
    await open();
    // in flight: not on the card, not in the header dot, not a reason for Quit to ask …
    expect(sent.map((s) => [s.id, s.autoClosed, s.note])).toEqual([['old', true, null]]);
    expect(study.queue()).toEqual([{ kind: 'note' }]);
    expect(study.getState().pending).toEqual([]);
    expect(study.hasUnsigned()).toBe(false);
    // … but still stored, so closing the tab before the POST lands loses nothing (re-sent: JS Journey dedups)
    expect(JSON.parse(storage.data.get(pendingKey(course.id, 'mansi')) ?? '[]')).toMatchObject([{ id: 'old' }]);
    release();
    await settle();
    expect(storage.data.has(pendingKey(course.id, 'mansi'))).toBe(false);
    study.autoClose();
    await settle();
    expect(sent).toHaveLength(1);
  });

  it('an auto-close the course server did not take goes back to pending and is tried again', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const skipped = { ...stale(), skippedAt: stale().lastStudyAt };
    const storage = memoryStore({ [pendingKey(course.id, 'mansi')]: JSON.stringify([skipped]) });
    let down = true;
    const sent: JourneySession[] = [];
    const send = async (s: JourneySession): Promise<void> => {
      if (down) throw new Error('server down');
      sent.push(s);
    };
    const { study, open } = setup({ storage, send, start: new Date(stale().lastStudyAt + PENDING_MAX_AGE_MS + 60_000) });
    await open();
    await settle();
    expect(study.getState().pending.map((p) => p.id)).toEqual(['old']);
    down = false;
    study.autoClose();
    await settle();
    expect(sent.map((s) => s.id)).toEqual(['old']);
    expect(study.getState().pending).toEqual([]);
    err.mockRestore();
  });

  // Review 2026-10-01: resume() runs before hydrate settles, and the update's snapshot (takenAt = now,
  // so JS Journey keeps it as newest) was built from this browser's copy — empty on a cleared browser.
  it('the 24 h rule waits for hydrate: its update carries the SSD copy of her progress', async () => {
    const skipped = { ...stale(), skippedAt: stale().lastStudyAt };
    const storage = memoryStore({ [pendingKey(course.id, 'mansi')]: JSON.stringify([skipped]) });
    const { study, progress, sent } = setup({ storage, start: new Date(stale().lastStudyAt + PENDING_MAX_AGE_MS + 60_000) });
    study.resume();
    study.autoClose();
    await settle();
    expect(sent).toHaveLength(0);
    await progress.hydrate();
    study.autoClose();
    await settle();
    expect(sent.map((s) => s.id)).toEqual(['old']);
  });

  it('a session on the open card is left alone by the 24 h rule; closing the card on it (skip) lets it go', async () => {
    const skipped = { ...stale(), skippedAt: stale().lastStudyAt };
    const storage = memoryStore({ [pendingKey(course.id, 'mansi')]: JSON.stringify([skipped]) });
    const { study, sent, jump, advance, open } = setup({ storage, start: new Date(stale().lastStudyAt + PENDING_MAX_AGE_MS - 30_000) });
    await open();
    const [target] = study.queue();
    const release = study.hold([target!]);
    jump(60_000); // crosses 24 h while the card asks
    advance(61);
    await settle();
    expect(sent).toHaveLength(0);
    study.skip(target!);
    await settle();
    expect(sent.map((s) => [s.id, s.autoClosed])).toEqual([['old', true]]);
    release();
  });

  it('her answer on the open card wins over the 24 h rule', async () => {
    const skipped = { ...stale(), skippedAt: stale().lastStudyAt };
    const storage = memoryStore({ [pendingKey(course.id, 'mansi')]: JSON.stringify([skipped]) });
    const { study, sent, jump, advance, open } = setup({ storage, start: new Date(stale().lastStudyAt + PENDING_MAX_AGE_MS - 30_000) });
    await open();
    const [target] = study.queue();
    const release = study.hold([target!]);
    jump(60_000);
    advance(61);
    await expect(study.signOff(target!, { mood: '🙂', note: 'useEffect cleanup confused me', stuck: false })).resolves.toBe('sent');
    release();
    expect(sent.map((s) => [s.id, s.autoClosed, s.note])).toEqual([['old', false, 'useEffect cleanup confused me']]);
  });

  it('signing off a session that already went to Rahul says so (gone), it is not a silent skip', async () => {
    const skipped = { ...stale(), skippedAt: stale().lastStudyAt };
    const storage = memoryStore({ [pendingKey(course.id, 'mansi')]: JSON.stringify([skipped]) });
    const { study, open } = setup({ storage, start: new Date(stale().lastStudyAt + PENDING_MAX_AGE_MS + 60_000) });
    await open();
    await settle();
    await expect(study.signOff({ kind: 'pending', session: skipped }, { mood: null, note: 'late note', stuck: false })).resolves.toBe('gone');
  });

  it('a v1 wrap-up left unanswered becomes a pending session (no data lost in the upgrade)', () => {
    const storage = memoryStore({ [legacyWrapKey(course.id, 'mansi')]: JSON.stringify({ session: stale(), endedAt: stale().lastStudyAt }) });
    const { study } = setup({ storage, start: new Date(2026, 8, 30, 9, 0) });
    study.resume();
    expect(study.getState().pending.map((s) => s.id)).toEqual(['old']);
    expect(storage.data.has(legacyWrapKey(course.id, 'mansi'))).toBe(false);
  });
});

describe('StudyController: signing off', () => {
  it('the queue: earlier sessions first (oldest first), then this one; a note-only target when nothing is unsigned', () => {
    const storage = memoryStore({ [pendingKey(course.id, 'mansi')]: JSON.stringify([stale()]) });
    const { study, play } = setup({ storage, start: new Date(2026, 8, 30, 9, 0) });
    study.resume();
    play(5, 60);
    expect(study.queue().map((t) => t.kind)).toEqual(['pending', 'live']);
    expect(setup().study.queue()).toEqual([{ kind: 'note' }]);
  });

  it('Send: one update with her note, mood, stuck flag and progress; the session resets to 0', async () => {
    const { study, sent, play } = setup();
    play(5, 10 * 60);
    const [target] = study.queue();
    await expect(study.signOff(target!, { mood: '😄', note: 'nice', stuck: true })).resolves.toBe('sent');
    expect(sent[0]).toMatchObject({ id: 'session-1', minutes: 10, mood: '😄', note: 'nice', stuck: true, autoClosed: false, progress: SNAP });
    expect(study.getState().live).toBeNull();
    expect(study.queue()).toEqual([{ kind: 'note' }]);
  });

  it('signs off what she studied up to Send, though the card opened earlier', async () => {
    const { study, sent, play } = setup();
    play(5, 6 * 60);
    const [target] = study.queue();
    play(5, 60); // the video kept playing behind the card
    await study.signOff(target!, noAnswer);
    expect(sent[0]?.minutes).toBe(7);
  });

  it('"Send without a note" on an earlier session: autoClosed false', async () => {
    const storage = memoryStore({ [pendingKey(course.id, 'mansi')]: JSON.stringify([stale()]) });
    const { study, sent } = setup({ storage, start: new Date(2026, 8, 30, 9, 0) });
    study.resume();
    await study.signOff(study.queue()[0]!, noAnswer);
    expect(sent[0]).toMatchObject({ id: 'old', autoClosed: false, note: null });
    expect(study.getState().pending).toEqual([]);
  });

  it('a note-only update (nothing studied in the player): minutes 0, her current section', async () => {
    const { study, sent } = setup();
    await expect(study.signOff({ kind: 'note' }, { mood: null, note: 'Read the docs on my phone', stuck: false })).resolves.toBe('sent');
    expect(sent[0]).toMatchObject({ minutes: 0, sectionNumber: 3, note: 'Read the docs on my phone' });
  });

  // Review 2026-10-01: with every lecture done there is no current section, and section 0 got JS
  // Journey's 400 — which the outbox drops for good, note and all.
  it('a note-only update after she finished every lecture: the section of her last lecture, else the last section', async () => {
    const answer: SignOffAnswer = { mood: null, note: 'Rebuilding the projects from scratch', stuck: false };
    const a = setup({ snapshot: { ...SNAP, current: null } });
    await a.progress.hydrate();
    a.progress.update((s, t) => withLast(s, id(0), t));
    await a.study.signOff({ kind: 'note' }, answer);
    expect(a.sent[0]?.sectionNumber).toBe(1);
    const b = setup({ snapshot: { ...SNAP, current: null } });
    await b.study.signOff({ kind: 'note' }, answer);
    expect(b.sent[0]?.sectionNumber).toBe(3);
  });

  it('under 5 min with no note: nothing is sent, the session still resets', async () => {
    const { study, sent, play } = setup();
    play(5, 4 * 60);
    await expect(study.signOff(study.queue()[0]!, noAnswer)).resolves.toBe('skipped');
    expect(sent).toHaveLength(0);
    expect(study.getState().live).toBeNull();
  });

  it('a send that fails (course server gone) keeps the session for another try', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { study, play } = setup({ send: async () => Promise.reject(new Error('server down')) });
    play(5, 10 * 60);
    await expect(study.signOff(study.queue()[0]!, noAnswer)).resolves.toBe('failed');
    expect(study.getState().live?.seconds).toBe(600);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('without JS Journey, signing off just resets (nothing can reach Rahul)', async () => {
    const { study, sent, play } = setup({ connected: false });
    play(5, 10 * 60);
    await expect(study.signOff(study.queue()[0]!, { mood: null, note: 'x', stuck: false })).resolves.toBe('skipped');
    expect(sent).toHaveLength(0);
    expect(study.getState().live).toBeNull();
  });

  it('Quit asks for a sign-off when anything is unsigned (≥ 1 min, or an earlier session) and JS Journey is connected', () => {
    const a = setup();
    a.play(5, 30);
    expect(a.study.hasUnsigned()).toBe(false);
    a.play(5, 60);
    expect(a.study.hasUnsigned()).toBe(true);
    const b = setup({ connected: false });
    b.play(5, 600);
    expect(b.study.hasUnsigned()).toBe(false);
  });
});

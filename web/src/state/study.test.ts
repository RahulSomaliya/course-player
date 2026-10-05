import { describe, expect, it, vi } from 'vitest';
import type { JourneySession, ProgressSnapshot, ProgressState } from '../../../shared/types';
import { indexCourse } from '../lib/course';
import { withLast } from '../lib/progress';
import type { SignOffAnswer } from '../lib/session';
import type { KeyValueStore } from '../lib/storage';
import { sampleCourse } from '../lib/test-fixtures';
import { ProgressStore } from './progress';
import { StudyController, studyKey } from './study';

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
const MIN = 60_000;
const answer = (over: Partial<SignOffAnswer> = {}): SignOffAnswer => ({ minutes: 0, mood: null, note: null, stuck: false, ...over });
const settle = () => new Promise((r) => setTimeout(r, 0));

type Opts = {
  storage?: KeyValueStore & { data: Map<string, string> };
  send?: (s: JourneySession) => Promise<unknown>;
  start?: Date;
  snapshot?: (state?: ProgressState) => ProgressSnapshot;
};

function setup(opts: Opts = {}) {
  const storage = opts.storage ?? memoryStore();
  let epoch = (opts.start ?? new Date(2026, 9, 5, 19, 0)).getTime();
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
    legacyCourseId: 'test-folder',
    profile: 'mansi',
    progress,
    index: indexCourse(course),
    storage,
    send: opts.send ?? (async (s) => void sent.push(s)),
    snapshot: opts.snapshot ?? ((state) => ({ ...SNAP, days: state?.days ?? {} })),
    clock: { now: () => epoch, perf: () => perf },
    isVisible: () => true,
    newId: () => `id-${++n}`,
  });
  /** wall-clock time passing with the app open (the 1 s ticker runs) */
  const advance = (seconds: number): void => {
    for (let i = 0; i < seconds; i++) {
      epoch += 1000;
      perf += 1000;
      study.tick();
    }
  };
  /** wall-clock time passing with the app closed / laptop asleep (no ticks) */
  const jump = (ms: number): void => {
    epoch += ms;
    perf += ms;
  };
  const play = (lecture: number, seconds: number): void => {
    study.setActivity({ lectureId: id(lecture), playing: true, reading: false });
    advance(seconds);
    study.setActivity({ playing: false });
  };
  return { study, progress, storage, sent, advance, jump, play, now: () => epoch };
}

describe('StudyController: the wall-clock study timer (spec v3 A3)', () => {
  it('Start studying starts one session, persisted under the NEW key; a second Start changes nothing', () => {
    const { study, storage, now } = setup();
    study.startSession();
    const s = study.getState().session;
    expect(s).toMatchObject({ id: 'id-1', startedAt: now(), autoStarted: false });
    expect(JSON.parse(storage.data.get(studyKey(course.id, 'mansi')) ?? 'null')).toMatchObject({ id: 'id-1' });
    expect(storage.data.has(`cp:${course.id}:mansi:session`)).toBe(false); // never v2's key
    study.startSession();
    expect(study.getState().session).toBe(s);
  });

  it('nothing pauses it: no lecture open, no input, the app closed for hours — it keeps running', () => {
    const storage = memoryStore();
    const a = setup({ storage });
    a.study.startSession();
    a.advance(600); // 10 min with nothing open
    const b = setup({ storage, start: new Date(a.now() + 3 * 3_600_000) }); // app reopened 3 h later
    b.study.resume();
    expect(b.study.getState().session).toMatchObject({ id: 'id-1', startedAt: new Date(2026, 9, 5, 19, 0).getTime() });
  });

  it('auto-start: playing / opening a lecture with no session starts one (autoStarted) and raises the quiet notice', () => {
    const { study, now } = setup();
    study.autoStart();
    expect(study.getState()).toMatchObject({ session: { autoStarted: true }, notice: { at: now() } });
  });

  it('auto-start while a session runs changes nothing (no second notice)', () => {
    const { study, jump } = setup();
    study.startSession();
    const before = study.getState();
    jump(MIN);
    study.autoStart();
    expect(study.getState()).toBe(before);
    expect(before.notice).toBeNull();
  });

  it('the player records WHERE she studied — and no longer writes study days (only a sign-off does)', async () => {
    const { study, progress, play } = setup();
    study.startSession();
    play(5, 90); // §03
    play(0, 30); // §01
    expect(progress.get().days).toEqual({});
    const r = await study.signOff(answer({ minutes: 2 }));
    expect(r.ok && r.update.sectionNumber).toBe(3);
  });

  it('no session → the ticker records nothing at all', () => {
    const { study, progress, play } = setup();
    play(5, 120);
    expect(study.getState().session).toBeNull();
    expect(progress.get().days).toEqual({});
  });

  it('records lectures completed and sections finished during the session', () => {
    const { study } = setup();
    study.startSession();
    study.setDone(id(0), true);
    study.setDone(id(1), true);
    study.setDone(id(2), true);
    expect(study.getState().session?.lecturesCompleted.map((l) => l.lecture)).toEqual([1, 2, 3]);
    expect(study.getState().session?.finishedSections).toEqual([1]);
    study.setDone(id(2), false);
    expect(study.getState().session?.lecturesCompleted.map((l) => l.lecture)).toEqual([1, 2]);
  });

  it('marking done with no session only changes progress', () => {
    const { study, progress } = setup();
    study.setDone(id(0), true);
    expect(progress.get().lectures[id(0)]?.done).toBe(true);
    expect(study.getState().session).toBeNull();
  });

  it('a stored v3 session of the wrong shape is not trusted (reported, then ignored)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const storage = memoryStore({ [studyKey(course.id, 'mansi')]: JSON.stringify({ id: 'x' }) });
    const { study } = setup({ storage });
    study.resume();
    expect(study.getState().session).toBeNull();
    warn.mockRestore();
  });
});

describe('StudyController: Send to Rahul', () => {
  it('one update: her minutes, startedAt → the moment she pressed Send; the timer stops at once', async () => {
    const { study, sent, jump, now } = setup();
    study.startSession();
    const startedAt = now();
    jump(83 * MIN + 20_000);
    const r = await study.signOff(answer({ minutes: 60, mood: '😄', note: 'props clicked', stuck: true }));
    expect(r.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      id: 'id-1',
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date(now()).toISOString(),
      minutes: 60,
      mood: '😄',
      note: 'props clicked',
      stuck: true,
      autoClosed: false,
      sectionNumber: 3, // no player time → her current section
    });
    expect(study.getState().session).toBeNull();
  });

  it('never more than the timer (the card caps it; this is the last guard)', async () => {
    const { study, sent, jump } = setup();
    study.startSession();
    jump(10 * MIN);
    await study.signOff(answer({ minutes: 90 }));
    expect(sent[0]?.minutes).toBe(10);
  });

  it('credits the minutes she SENT to the days the session spanned — and the update carries them', async () => {
    const { study, progress, sent, jump } = setup({ start: new Date(2026, 9, 5, 23, 0) });
    await progress.hydrate();
    study.startSession();
    jump(3 * 60 * MIN); // 23:00 → 02:00: 1 h before midnight, 2 h after
    await study.signOff(answer({ minutes: 60 }));
    expect(progress.get().days).toEqual({ '2026-10-05': 1200, '2026-10-06': 2400 });
    expect(sent[0]?.progress?.days).toEqual({ '2026-10-05': 1200, '2026-10-06': 2400 });
  });

  it('nothing to send (0 min, no note): refused with the reason, nothing posted, the timer keeps running', async () => {
    const { study, sent } = setup();
    study.startSession();
    const r = await study.signOff(answer({ mood: '🙂' }));
    expect(r).toEqual({ ok: false, error: 'Add the time you studied, or a note.' });
    expect(sent).toHaveLength(0);
    expect(study.getState().session).not.toBeNull();
  });

  it('the course server did not take it: the timer keeps running, no study time is credited, it says why', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { study, progress, jump } = setup({ send: async () => Promise.reject(new Error('server down')) });
    await progress.hydrate();
    study.startSession();
    jump(30 * MIN);
    const r = await study.signOff(answer({ minutes: 30 }));
    expect(r).toEqual({ ok: false, error: 'Couldn’t hand it to the course app — is it still running? Try again.' });
    expect(study.getState().session).not.toBeNull();
    expect(progress.get().days).toEqual({});
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  // 2026-10-05: v2 returned 'skipped' when JS Journey was not connected and forgot the session.
  it('JS Journey not connected is not a reason to drop it: it is handed to the outbox like any other', async () => {
    const { study, sent, jump } = setup();
    study.startSession();
    jump(20 * MIN);
    await study.signOff(answer({ minutes: 20 }));
    expect(sent.map((s) => s.minutes)).toEqual([20]);
  });

  it('Note to Rahul…: a note-only update (0 min, its own id) — a running timer is left alone', async () => {
    const { study, sent, progress, jump } = setup();
    await progress.hydrate();
    study.startSession();
    jump(15 * MIN);
    const r = await study.sendNote(answer({ minutes: 15, note: 'Read the docs on my phone' }));
    expect(r.ok).toBe(true);
    expect(sent[0]).toMatchObject({ id: 'id-2', minutes: 0, sectionNumber: 3, note: 'Read the docs on my phone' });
    expect(study.getState().session?.id).toBe('id-1');
    expect(progress.get().days).toEqual({});
    await expect(study.sendNote(answer({ note: '  ' }))).resolves.toEqual({ ok: false, error: 'Write a note for Rahul.' });
  });

  // Review 2026-10-01: with every lecture done there is no current section, and section 0 got JS
  // Journey's 400.
  it('no player time and no current lecture: the section of her last lecture, else the last section', async () => {
    const a = setup({ snapshot: () => ({ ...SNAP, current: null }) });
    await a.progress.hydrate();
    a.progress.update((s, t) => withLast(s, id(0), t));
    await a.study.sendNote(answer({ note: 'Rebuilding the projects' }));
    expect(a.sent[0]?.sectionNumber).toBe(1);
    const b = setup({ snapshot: () => ({ ...SNAP, current: null }) });
    await b.study.sendNote(answer({ note: 'Rebuilding the projects' }));
    expect(b.sent[0]?.sectionNumber).toBe(3);
  });

  it('Try again after JS Journey refused it: the same update (same id) with her edits — no study time twice', async () => {
    const { study, progress, sent, jump } = setup();
    await progress.hydrate();
    study.startSession();
    jump(40 * MIN);
    const first = await study.signOff(answer({ minutes: 40, note: 'first try' }));
    if (!first.ok) throw new Error('expected the hand-over to work');
    const daysAfterFirst = progress.get().days;
    await study.resend({ ...first.update, note: 'second try' });
    expect(sent.map((s) => [s.id, s.note])).toEqual([
      ['id-1', 'first try'],
      ['id-1', 'second try'],
    ]);
    expect(progress.get().days).toBe(daysAfterFirst);
  });

  it('Discard: the session is gone — nothing sent, no study time credited', async () => {
    const { study, sent, progress, storage, jump } = setup();
    await progress.hydrate();
    study.startSession();
    jump(3 * MIN);
    study.discard();
    expect(study.getState().session).toBeNull();
    expect(storage.data.has(studyKey(course.id, 'mansi'))).toBe(false);
    expect(sent).toHaveLength(0);
    expect(progress.get().days).toEqual({});
  });
});

describe('StudyController: v2 state left in this browser (spec v3 A3 "Legacy v2 state")', () => {
  const tue = new Date(2026, 8, 29, 20, 0).getTime();
  const v2 = (sid: string, seconds: number) => ({
    id: sid,
    startedAt: tue,
    lastStudyAt: tue + seconds * 1000,
    seconds,
    sectionSeconds: { 3: seconds },
    lecturesCompleted: [],
    finishedSections: [],
  });

  it('each v2 session ≥ 1 min is sent once as recorded (autoClosed, no note) — under either course id — then the keys go', async () => {
    const storage = memoryStore({
      [`cp:${course.id}:mansi:session`]: JSON.stringify(v2('live', 42 * 60)),
      'cp:test-folder:mansi:pending': JSON.stringify([{ ...v2('tue', 72 * 60), skippedAt: tue }]),
      'cp:test-folder:mansi:wrap': JSON.stringify({ session: v2('blip', 20), endedAt: tue }),
    });
    const { study, sent, progress } = setup({ storage });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await study.migrateLegacy();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('blip')); // the 20 s one: said, not silently dropped
    warn.mockRestore();
    expect(sent.map((s) => [s.id, s.minutes, s.autoClosed, s.note])).toEqual([
      ['live', 42, true, null],
      ['tue', 72, true, null],
    ]);
    expect([...storage.data.keys()].filter((k) => /:(session|pending|wrap)$/.test(k))).toEqual([]);
    expect(progress.get().days).toEqual({}); // v2 already counted it in days
    expect(study.getState().session).toBeNull(); // a v2 session never becomes a running v3 timer
  });

  it('the course server did not take them: the keys stay, so the next open sends them again', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const key = `cp:${course.id}:mansi:pending`;
    const storage = memoryStore({ [key]: JSON.stringify([v2('tue', 72 * 60)]) });
    const { study } = setup({ storage, send: async () => Promise.reject(new Error('server down')) });
    await study.migrateLegacy();
    expect(storage.data.has(key)).toBe(true);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  // Review 2026-10-01: an update's snapshot (takenAt = now, so JS Journey keeps it as the newest) built
  // from a cleared browser's empty copy overwrote the coach's numbers. It must come from the SSD copy.
  it('waits for the SSD progress copy before building the updates', async () => {
    const storage = memoryStore({ [`cp:${course.id}:mansi:session`]: JSON.stringify(v2('live', 42 * 60)) });
    const { study, progress, sent } = setup({ storage });
    const hydrate = vi.spyOn(progress, 'hydrate');
    await study.migrateLegacy();
    expect(hydrate).toHaveBeenCalled();
    expect(progress.isHydrated()).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('two opens at once (StrictMode runs App\'s effect twice) share ONE migration', async () => {
    const storage = memoryStore({ [`cp:${course.id}:mansi:session`]: JSON.stringify(v2('live', 42 * 60)) });
    const { study, sent } = setup({ storage });
    await Promise.all([study.migrateLegacy(), study.migrateLegacy()]);
    expect(sent.map((s) => s.id)).toEqual(['live']);
  });

  it('nothing left from v2 → nothing sent', async () => {
    const { study, sent } = setup();
    await study.migrateLegacy();
    await settle();
    expect(sent).toEqual([]);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { JourneySession } from '../../../shared/types';
import { indexCourse } from '../lib/course';
import { localDateKey } from '../lib/dates';
import { SESSION_IDLE_MS, type LiveSession } from '../lib/session';
import type { KeyValueStore } from '../lib/storage';
import { sampleCourse } from '../lib/test-fixtures';
import { ProgressStore } from './progress';
import { StudyController, sessionKey, wrapKey } from './study';

function memoryStore(init: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

const course = sampleCourse();
const ids = course.sections.flatMap((s) => s.lectures.map((l) => l.id));
const id = (i: number): string => ids[i] as string;

function setup(
  opts: { connected?: boolean; storage?: KeyValueStore & { data: Map<string, string> }; send?: (s: JourneySession) => Promise<unknown> } = {},
) {
  const storage = opts.storage ?? memoryStore();
  let epoch = new Date(2026, 9, 1, 19, 0).getTime();
  let perf = 0;
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
    clock: { now: () => epoch, perf: () => perf },
    isVisible: () => true,
    newId: () => 'session-1',
  });
  const advance = (seconds: number, tick = true): void => {
    for (let i = 0; i < seconds; i++) {
      epoch += 1000;
      perf += 1000;
      if (tick) study.tick();
    }
  };
  return { study, progress, storage, sent, advance, epoch: () => epoch };
}

describe('StudyController', () => {
  it('a playing video adds study time to today and starts a session in its section', () => {
    const { study, progress, advance, epoch } = setup();
    study.setActivity({ lectureId: id(5), playing: true, reading: false });
    advance(90);
    expect(progress.get().days[localDateKey(new Date(epoch()))]).toBe(90);
    expect(study.getSession()).toMatchObject({ seconds: 90, sectionSeconds: { 3: 90 } });
  });

  it('nothing open → no study time, no session', () => {
    const { study, progress, advance } = setup();
    advance(30);
    expect(progress.get().days).toEqual({});
    expect(study.getSession()).toBeNull();
  });

  it('persists the live session so a reload continues it', () => {
    const storage = memoryStore();
    const a = setup({ storage });
    a.study.setActivity({ lectureId: id(0), playing: true, reading: false });
    a.advance(60);
    const b = setup({ storage });
    b.study.resume();
    expect(b.study.getSession()?.seconds).toBe(60);
  });

  it('ends silently after 20 min without studying and sends it (≥ 5 min, connected)', () => {
    const { study, sent, advance } = setup();
    study.setActivity({ lectureId: id(5), playing: true, reading: false });
    advance(6 * 60);
    study.setActivity({ playing: false });
    advance(SESSION_IDLE_MS / 1000 + 2);
    expect(study.getSession()).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ minutes: 6, mood: null, note: null, sectionNumber: 3 });
  });

  it('idle sessions under 5 min end without sending', () => {
    const { study, sent, advance } = setup();
    study.setActivity({ lectureId: id(5), playing: true, reading: false });
    advance(4 * 60);
    study.setActivity({ playing: false });
    advance(SESSION_IDLE_MS / 1000 + 2);
    expect(study.getSession()).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('a profile without JS Journey never sends', () => {
    const { study, sent, advance } = setup({ connected: false });
    study.setActivity({ lectureId: id(5), playing: true, reading: false });
    advance(6 * 60);
    expect(study.endSession()).not.toBeNull();
    expect(study.needsWrapUp(study.getSession())).toBe(false);
    advance(SESSION_IDLE_MS / 1000 + 2);
    expect(sent).toHaveLength(0);
  });

  it('on app open, a stored session idle > 20 min is finalized silently', () => {
    const stale: LiveSession = {
      id: 'old',
      startedAt: new Date(2026, 9, 1, 9, 0).getTime(),
      lastStudyAt: new Date(2026, 9, 1, 9, 30).getTime(),
      seconds: 1800,
      sectionSeconds: { 1: 1800 },
      lecturesCompleted: [],
      finishedSections: [],
    };
    const storage = memoryStore({ [sessionKey(course.id, 'mansi')]: JSON.stringify(stale) });
    const { study, sent } = setup({ storage });
    study.resume();
    expect(study.getSession()).toBeNull();
    expect(sent.map((s) => s.id)).toEqual(['old']);
    expect(sent[0]?.endedAt).toBe(new Date(stale.lastStudyAt).toISOString());
    expect(storage.data.has(sessionKey(course.id, 'mansi'))).toBe(false);
  });

  it('records lectures completed and sections finished during the session', () => {
    const { study, advance } = setup();
    study.setActivity({ lectureId: id(0), playing: true, reading: false });
    advance(10);
    study.setDone(id(0), true);
    study.setDone(id(1), true);
    study.setDone(id(2), true);
    const s = study.getSession();
    expect(s?.lecturesCompleted.map((l) => l.lecture)).toEqual([1, 2, 3]);
    expect(s?.finishedSections).toEqual([1]);
    study.setDone(id(2), false);
    expect(study.getSession()?.lecturesCompleted.map((l) => l.lecture)).toEqual([1, 2]);
  });

  it('marking done with no session running only changes progress', () => {
    const { study, progress } = setup();
    study.setDone(id(0), true);
    expect(progress.get().lectures[id(0)]?.done).toBe(true);
    expect(study.getSession()).toBeNull();
  });

  it('End session returns the snapshot for the wrap-up card, then send() posts mood + note', async () => {
    const { study, sent, advance } = setup();
    study.setActivity({ lectureId: id(5), playing: true, reading: false });
    advance(10 * 60);
    const snap = study.endSession();
    expect(study.getSession()).toBeNull();
    expect(study.needsWrapUp(snap)).toBe(true);
    await study.send(snap as LiveSession, { mood: '😄', note: 'nice', endedAt: Date.now() });
    expect(sent[0]).toMatchObject({ minutes: 10, mood: '😄', note: 'nice' });
  });

  it('an article counts only while there was input in the last 3 min', () => {
    const { study, progress, advance, epoch } = setup();
    study.setActivity({ lectureId: id(4), playing: false, reading: true });
    study.noteInput();
    advance(200);
    expect(progress.get().days[localDateKey(new Date(epoch()))]).toBe(180);
  });

  it('reports send failures without throwing (the outbox lives on the server)', async () => {
    const { study, advance } = setup();
    const bad = new StudyController({
      courseId: course.id,
      profile: 'mansi',
      progress: new ProgressStore({ courseId: course.id, profile: 'x', storage: null, api: { get: async () => null, put: async () => undefined } }),
      index: indexCourse(course),
      storage: null,
      isConnected: () => true,
      send: async () => {
        throw new Error('server down');
      },
    });
    study.setActivity({ lectureId: id(5), playing: true, reading: false });
    advance(6 * 60);
    const snap = study.endSession() as LiveSession;
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(bad.send(snap, { mood: null, note: null, endedAt: snap.lastStudyAt })).resolves.toBe(false);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

// Review finding (2026-10-01): End session / Quit dropped the persisted live session BEFORE the wrap-up
// card was answered, and only Send/Skip posted it. Closing the tab, the browser or the lid while the
// card showed (natural right after Quit) lost a >= 5 min session for good. Spec: Skip "still sends".
describe('StudyController: the wrap-up card vs closing the page', () => {
  const playMinutes = (minutes: number, opts: Parameters<typeof setup>[0] = {}) => {
    const t = setup(opts);
    t.study.setActivity({ lectureId: id(0), playing: true, reading: false });
    t.advance(minutes * 60);
    return t;
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('a 30-min session whose wrap-up card is never answered is still sent on the next open', async () => {
    const storage = memoryStore();
    const first = playMinutes(30, { storage });
    const ended = first.study.endSession(); // Quit pressed: the card shows …
    expect(first.study.needsWrapUp(ended)).toBe(true);
    // … and the tab is closed instead of Send/Skip. The app is opened again later.
    const second = setup({ storage });
    second.study.resume();
    await settle();
    expect(second.sent.map((s) => s.id)).toEqual(['session-1']);
    expect(second.sent[0]).toMatchObject({ minutes: 30, mood: null, note: null });
    expect(storage.data.has(wrapKey(course.id, 'mansi'))).toBe(false);
  });

  it('pagehide while the card shows posts it as Skip would (mood/note null)', async () => {
    const { study, sent, storage } = playMinutes(10);
    study.endSession();
    study.sendPendingWrap();
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ minutes: 10, mood: null, note: null });
    expect(storage.data.has(wrapKey(course.id, 'mansi'))).toBe(false);
  });

  it('answering the card clears it, so the next open sends nothing more', async () => {
    const storage = memoryStore();
    const first = playMinutes(10, { storage });
    const snap = first.study.endSession() as LiveSession;
    await first.study.send(snap, { mood: '🙂', note: null, endedAt: snap.lastStudyAt });
    const second = setup({ storage });
    second.study.resume();
    await settle();
    expect(first.sent).toHaveLength(1);
    expect(second.sent).toHaveLength(0);
  });

  it('a send that fails (course server gone) keeps it for the next open', async () => {
    const storage = memoryStore();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const first = playMinutes(10, { storage, send: async () => Promise.reject(new Error('server down')) });
    const snap = first.study.endSession() as LiveSession;
    await expect(first.study.send(snap, { mood: '😄', note: null, endedAt: snap.lastStudyAt })).resolves.toBe(false);
    err.mockRestore();
    const second = setup({ storage });
    second.study.resume();
    await settle();
    expect(second.sent.map((s) => s.id)).toEqual(['session-1']);
  });

  it('a session that needs no wrap-up card leaves nothing pending', () => {
    const short = playMinutes(4);
    short.study.endSession();
    expect(short.storage.data.has(wrapKey(course.id, 'mansi'))).toBe(false);
    const offline = playMinutes(10, { connected: false });
    offline.study.endSession();
    expect(offline.storage.data.has(wrapKey(course.id, 'mansi'))).toBe(false);
  });
});

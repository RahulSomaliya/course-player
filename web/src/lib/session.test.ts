import { describe, expect, it } from 'vitest';
import {
  MIN_SEND_SECONDS,
  SESSION_IDLE_MS,
  accumulate,
  addCompleted,
  addFinishedSection,
  isLiveSession,
  isWaiting,
  removeCompleted,
  toUpdate,
  type LiveSession,
  type SignOffAnswer,
} from './session';
import type { ProgressSnapshot } from '../../../shared/types';

const T0 = new Date(2026, 9, 1, 23, 50).getTime(); // 23:50 local — the session crosses midnight
let n = 0;
const newId = (): string => `id-${++n}`;

function studied(minutes: number, section = 5, start = T0): LiveSession {
  let s: LiveSession | null = null;
  for (let i = 0; i < minutes * 60; i++) s = accumulate(s, start + i * 1000, 1, section, newId);
  return s as LiveSession;
}

describe('session lifecycle', () => {
  it('starts with the first studied second', () => {
    const s = accumulate(null, T0, 1, 5, () => 'abc');
    expect(s).toMatchObject({ id: 'abc', startedAt: T0 - 1000, lastStudyAt: T0, seconds: 1, sectionSeconds: { 5: 1 } });
  });
  it('accumulates per-section seconds', () => {
    let s = accumulate(null, T0, 3, 5, newId);
    s = accumulate(s, T0 + 3000, 2, 6, newId);
    s = accumulate(s, T0 + 5000, 4, 5, newId);
    expect(s.seconds).toBe(9);
    expect(s.sectionSeconds).toEqual({ 5: 7, 6: 2 });
    expect(s.lastStudyAt).toBe(T0 + 5000);
  });
  it('waits for her note after 20 min with no studying', () => {
    const s = studied(1);
    expect(isWaiting(s, s.lastStudyAt + SESSION_IDLE_MS)).toBe(false);
    expect(isWaiting(s, s.lastStudyAt + SESSION_IDLE_MS + 1)).toBe(true);
  });
  it('records lectures completed during it once, and forgets an un-done one', () => {
    let s = studied(1);
    s = addCompleted(s, { section: 5, lecture: 13, title: 'Profile Card' });
    s = addCompleted(s, { section: 5, lecture: 13, title: 'Profile Card' });
    s = addCompleted(s, { section: 5, lecture: 14, title: 'Next' });
    expect(s.lecturesCompleted).toHaveLength(2);
    s = removeCompleted(s, 5, 14);
    expect(s.lecturesCompleted).toEqual([{ section: 5, lecture: 13, title: 'Profile Card' }]);
  });
  it('records finished sections once', () => {
    let s = addFinishedSection(studied(1), 5);
    s = addFinishedSection(s, 5);
    expect(s.finishedSections).toEqual([5]);
  });
  it('round-trips through storage validation', () => {
    const s = studied(2);
    expect(isLiveSession(JSON.parse(JSON.stringify(s)))).toBe(true);
    expect(isLiveSession({ ...s, seconds: 'x' })).toBe(false);
    expect(isLiveSession(null)).toBe(false);
  });
});

const snapshot: ProgressSnapshot = {
  course: 'react-2023',
  takenAt: T0,
  lecturesDone: 40,
  lecturesTotal: 410,
  videoSecondsDone: 36_000,
  videoSecondsTotal: 241_822,
  sectionsDone: [1, 3],
  current: { sectionNumber: 7, lectureNumber: 4, title: 'Thinking About State' },
  days: { '2026-10-01': 600 },
};
const answer = (over: Partial<SignOffAnswer> = {}): SignOffAnswer => ({ mood: null, note: null, stuck: false, ...over });
const base = { courseId: 'react-2023', noteId: 'note-1', autoClosed: false, progress: snapshot, fallbackSection: 7 };

describe('toUpdate (one sign-off = one update for Rahul)', () => {
  it('maps a session to the JS Journey contract; endedAt = the last studied second', () => {
    let s = studied(10, 5);
    s = accumulate(s, s.lastStudyAt + 1000, 120, 6, newId); // 2 min in §06
    s = addCompleted(s, { section: 5, lecture: 13, title: 'Profile Card' });
    s = addFinishedSection(s, 5);
    const now = s.lastStudyAt + 15 * 60_000; // she wrote her note a while later
    const j = toUpdate(s, { ...base, now, answer: answer({ mood: '🙂', note: '  felt good ', stuck: true }) });
    expect(j).toEqual({
      id: s.id,
      course: 'react-2023',
      startedAt: new Date(s.startedAt).toISOString(),
      endedAt: new Date(s.lastStudyAt).toISOString(),
      studyDate: '2026-10-01', // the local day it STARTED on, though it ended after midnight
      minutes: 12,
      sectionNumber: 5,
      lecturesCompleted: [{ section: 5, lecture: 13, title: 'Profile Card' }],
      finishedSections: [5],
      mood: '🙂',
      note: 'felt good',
      stuck: true,
      autoClosed: false,
      progress: snapshot,
    });
  });
  it('a session under 5 min with no note is not sent', () => {
    const s = studied(4);
    expect(s.seconds).toBeLessThan(MIN_SEND_SECONDS);
    expect(toUpdate(s, { ...base, now: s.lastStudyAt, answer: answer() })).toBeNull();
    expect(toUpdate(s, { ...base, now: s.lastStudyAt, answer: answer({ note: '   ', mood: '😄', stuck: true }) })).toBeNull();
  });
  it('a session under 5 min WITH a note is sent', () => {
    const s = studied(3);
    expect(toUpdate(s, { ...base, now: s.lastStudyAt, answer: answer({ note: 'quick review' }) })).toMatchObject({ minutes: 3, note: 'quick review' });
  });
  it('a note-only update (studied away from the player): minutes 0, now, her current section', () => {
    const now = new Date(2026, 9, 2, 8, 30).getTime();
    expect(toUpdate(null, { ...base, now, answer: answer({ note: 'Read the useEffect docs on my phone', mood: '😐' }) })).toEqual({
      id: 'note-1',
      course: 'react-2023',
      startedAt: new Date(now).toISOString(),
      endedAt: new Date(now).toISOString(),
      studyDate: '2026-10-02',
      minutes: 0,
      sectionNumber: 7,
      lecturesCompleted: [],
      finishedSections: [],
      mood: '😐',
      note: 'Read the useEffect docs on my phone',
      stuck: false,
      autoClosed: false,
      progress: snapshot,
    });
  });
  it('nothing studied and no note → nothing to send', () => {
    expect(toUpdate(null, { ...base, now: T0, answer: answer({ mood: '😄' }) })).toBeNull();
  });
  it('a session too short to round to a minute still goes as a note when she writes one', () => {
    const s = accumulate(null, T0, 20, 5, () => 'tiny');
    expect(toUpdate(s, { ...base, now: T0, answer: answer({ note: 'hi' }) })).toMatchObject({ id: 'tiny', minutes: 0, sectionNumber: 5 });
  });
  it('carries autoClosed (the 24 h rule) and caps the note at 2000 chars', () => {
    const s = studied(6);
    const j = toUpdate(s, { ...base, now: s.lastStudyAt, autoClosed: true, answer: answer({ note: 'x'.repeat(2500) }) });
    expect(j?.autoClosed).toBe(true);
    expect(j?.note).toHaveLength(2000);
  });
  it('caps minutes at 1440, JS Journey\'s limit (a 4xx there would drop the whole update for good)', () => {
    const s = accumulate(null, T0, 25 * 3600, 5, () => 'marathon');
    expect(toUpdate(s, { ...base, now: s.lastStudyAt, answer: answer() })?.minutes).toBe(1440);
  });
});

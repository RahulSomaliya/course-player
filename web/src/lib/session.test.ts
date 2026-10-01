import { describe, expect, it } from 'vitest';
import {
  MIN_SEND_SECONDS,
  SESSION_IDLE_MS,
  accumulate,
  addCompleted,
  addFinishedSection,
  isIdle,
  isLiveSession,
  removeCompleted,
  toJourneySession,
  type LiveSession,
} from './session';

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
  it('is idle after 20 min with no studying', () => {
    const s = studied(1);
    expect(isIdle(s, s.lastStudyAt + SESSION_IDLE_MS)).toBe(false);
    expect(isIdle(s, s.lastStudyAt + SESSION_IDLE_MS + 1)).toBe(true);
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

describe('toJourneySession', () => {
  it('drops sessions under 5 min (they still count in local stats)', () => {
    const s = studied(4);
    expect(s.seconds).toBeLessThan(MIN_SEND_SECONDS);
    expect(toJourneySession(s, { courseId: 'react-2023', endedAt: s.lastStudyAt, mood: null, note: null })).toBeNull();
  });
  it('maps to the JS Journey contract', () => {
    let s = studied(10, 5);
    s = accumulate(s, s.lastStudyAt + 1000, 120, 6, newId); // 2 min in §06
    s = addCompleted(s, { section: 5, lecture: 13, title: 'Profile Card' });
    s = addFinishedSection(s, 5);
    const j = toJourneySession(s, { courseId: 'react-2023', endedAt: s.lastStudyAt, mood: '🙂', note: '  felt good ' });
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
    });
  });
  it('sends an empty note as null', () => {
    const s = studied(6);
    expect(toJourneySession(s, { courseId: 'c', endedAt: s.lastStudyAt, mood: null, note: '   ' })?.note).toBeNull();
  });
});

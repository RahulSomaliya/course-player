import { describe, expect, it } from 'vitest';
import type { ProgressSnapshot } from '../../../shared/types';
import {
  MAX_UPDATE_MINUTES,
  addCompleted,
  addFinishedSection,
  addSectionTime,
  canSend,
  isStudySession,
  liveDays,
  mainSection,
  newSession,
  removeCompleted,
  sendableMinutes,
  splitAcrossDays,
  timerMinutes,
  toUpdate,
  type SignOffAnswer,
  type StudySession,
} from './session';

const T0 = new Date(2026, 9, 5, 21, 0).getTime(); // Mon 5 Oct, 21:00 local
const MIN = 60_000;
const HOUR = 3_600_000;

describe('the study session = one wall-clock timer (spec v3 A3)', () => {
  it('starts at Start (or the auto-start) and counts wall-clock time — nothing pauses it', () => {
    const s = newSession('s1', T0, false);
    expect(s).toEqual({ id: 's1', startedAt: T0, autoStarted: false, lecturesCompleted: [], finishedSections: [], sectionSeconds: {} });
    expect(timerMinutes(s, T0 + 59_999)).toBe(0);
    expect(timerMinutes(s, T0 + 83 * MIN + 59_000)).toBe(83); // rounded DOWN to the minute
    // no player time at all (coding in VS Code): the timer runs anyway
    expect(timerMinutes(s, T0 + 3 * HOUR)).toBe(180);
  });

  it('a clock that went backwards never makes the timer negative', () => {
    expect(timerMinutes(newSession('s', T0, false), T0 - 5 * MIN)).toBe(0);
  });

  it('what she can send is the timer, capped at 24 h (JS Journey refuses more than 1440 min per update)', () => {
    const s = newSession('s', T0, false);
    expect(sendableMinutes(s, T0 + 90 * MIN)).toBe(90);
    expect(sendableMinutes(s, T0 + 30 * HOUR)).toBe(MAX_UPDATE_MINUTES);
  });

  it('records WHERE she studied (player time per section), lectures completed and sections finished', () => {
    let s = newSession('s', T0, true);
    s = addSectionTime(s, 5, 30);
    s = addSectionTime(s, 6, 90);
    s = addSectionTime(s, 5, 10);
    expect(s.sectionSeconds).toEqual({ 5: 40, 6: 90 });
    expect(mainSection(s)).toBe(6);
    s = addCompleted(s, { section: 5, lecture: 13, title: 'Profile Card' });
    s = addCompleted(s, { section: 5, lecture: 13, title: 'Profile Card' });
    s = addCompleted(s, { section: 5, lecture: 14, title: 'Next' });
    s = removeCompleted(s, 5, 14);
    expect(s.lecturesCompleted).toEqual([{ section: 5, lecture: 13, title: 'Profile Card' }]);
    s = addFinishedSection(addFinishedSection(s, 5), 5);
    expect(s.finishedSections).toEqual([5]);
  });

  it('mainSection: ties go to the lower section; no player time → 0 (the caller falls back)', () => {
    expect(mainSection(newSession('s', T0, false))).toBe(0);
    expect(mainSection({ ...newSession('s', T0, false), sectionSeconds: { 7: 60, 3: 60 } })).toBe(3);
  });

  it('round-trips through storage validation; the v2 shape is not a v3 session', () => {
    const s = addSectionTime(newSession('s', T0, true), 3, 12);
    expect(isStudySession(JSON.parse(JSON.stringify(s)))).toBe(true);
    expect(isStudySession({ ...s, startedAt: 'x' })).toBe(false);
    expect(isStudySession({ ...s, autoStarted: undefined })).toBe(false);
    expect(isStudySession(null)).toBe(false);
    const v2 = { id: 'old', startedAt: T0, lastStudyAt: T0, seconds: 60, sectionSeconds: {}, lecturesCompleted: [], finishedSections: [] };
    expect(isStudySession(v2)).toBe(false);
  });
});

describe('canSend = JS Journey canSignOff (minutes > 0 or a note)', () => {
  it('needs time or a note; a mood alone is not enough', () => {
    expect(canSend(1, null)).toBe(true);
    expect(canSend(0, 'read the docs')).toBe(true);
    expect(canSend(0, '   ')).toBe(false);
    expect(canSend(0, null)).toBe(false);
  });
});

describe('splitAcrossDays: the minutes she sends, credited to the days the session spanned', () => {
  it('all on one day', () => {
    expect(splitAcrossDays(T0, T0 + HOUR, 3000)).toEqual({ '2026-10-05': 3000 });
  });

  it('proportional to the wall-clock time in each local day, summing exactly to what she sent', () => {
    const start = new Date(2026, 9, 5, 23, 0).getTime();
    const end = new Date(2026, 9, 6, 2, 0).getTime(); // 1 h before midnight, 2 h after
    expect(splitAcrossDays(start, end, 3600)).toEqual({ '2026-10-05': 1200, '2026-10-06': 2400 });
    const odd = splitAcrossDays(start, end, 100);
    expect(Object.values(odd).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('a timer forgotten for days spreads over every day it ran', () => {
    const start = new Date(2026, 9, 5, 12, 0).getTime();
    const end = new Date(2026, 9, 7, 12, 0).getTime(); // 12 h · 24 h · 12 h
    expect(splitAcrossDays(start, end, 4800)).toEqual({ '2026-10-05': 1200, '2026-10-06': 2400, '2026-10-07': 1200 });
  });

  it('nothing to credit → nothing; no span → the start day', () => {
    expect(splitAcrossDays(T0, T0 + HOUR, 0)).toEqual({});
    expect(splitAcrossDays(T0, T0, 600)).toEqual({ '2026-10-05': 600 });
  });
});

describe('liveDays: the running timer shown in Today / the streak / the chart (display only)', () => {
  it('adds the elapsed time to the days it spans, on top of what is saved', () => {
    const s = newSession('s', new Date(2026, 9, 5, 23, 30).getTime(), false);
    const now = new Date(2026, 9, 6, 0, 30).getTime();
    expect(liveDays({ '2026-10-05': 600 }, s, now)).toEqual({ '2026-10-05': 600 + 1800, '2026-10-06': 1800 });
  });

  it('never more than 24 h, like what she can send', () => {
    const s = newSession('s', T0, false);
    const shown = liveDays({}, s, T0 + 40 * HOUR);
    expect(Object.values(shown).reduce((a, b) => a + b, 0)).toBe(MAX_UPDATE_MINUTES * 60);
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
  days: { '2026-10-05': 600 },
};
const answer = (over: Partial<SignOffAnswer> = {}): SignOffAnswer => ({ minutes: 0, mood: null, note: null, stuck: false, ...over });
const base = { courseId: 'react-2023', noteId: 'note-1', progress: snapshot, fallbackSection: 7 };

describe('toUpdate (one sign-off = one update for Rahul)', () => {
  it('a session: her (edited) minutes, endedAt = the moment she pressed Send, studyDate = the day it started', () => {
    let s: StudySession = newSession('s1', new Date(2026, 9, 5, 23, 10).getTime(), true);
    s = addSectionTime(addSectionTime(s, 5, 600), 6, 120);
    s = addFinishedSection(addCompleted(s, { section: 5, lecture: 13, title: 'Profile Card' }), 5);
    const now = new Date(2026, 9, 6, 0, 40).getTime();
    expect(toUpdate(s, { ...base, now, answer: answer({ minutes: 75, mood: '🙂', note: '  felt good ', stuck: true }) })).toEqual({
      id: 's1',
      course: 'react-2023',
      startedAt: new Date(s.startedAt).toISOString(),
      endedAt: new Date(now).toISOString(),
      studyDate: '2026-10-05',
      minutes: 75,
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

  it('no player time in the session → her current section (never 0: JS Journey 400s it)', () => {
    const s = newSession('s', T0, false);
    expect(toUpdate(s, { ...base, now: T0 + HOUR, answer: answer({ minutes: 60 }) })?.sectionNumber).toBe(7);
  });

  it('a note-only update (Note to Rahul…): minutes 0, now, her current section, its own id', () => {
    const now = new Date(2026, 9, 6, 8, 30).getTime();
    expect(toUpdate(null, { ...base, now, answer: answer({ minutes: 45, note: 'Read the useEffect docs on my phone', mood: '😐' }) })).toEqual({
      id: 'note-1',
      course: 'react-2023',
      startedAt: new Date(now).toISOString(),
      endedAt: new Date(now).toISOString(),
      studyDate: '2026-10-06',
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

  it('nothing to send (0 min and no note) → null', () => {
    expect(toUpdate(newSession('s', T0, false), { ...base, now: T0 + HOUR, answer: answer({ minutes: 0, mood: '😄' }) })).toBeNull();
    expect(toUpdate(null, { ...base, now: T0, answer: answer({ note: '  ' }) })).toBeNull();
  });

  it('a 0-minute session with a note still goes (as a note)', () => {
    expect(toUpdate(newSession('tiny', T0, false), { ...base, now: T0 + 20_000, answer: answer({ note: 'hi' }) })).toMatchObject({ id: 'tiny', minutes: 0 });
  });

  it('caps minutes at 1440 and the note at 2000 chars; minutes are whole and never negative', () => {
    const s = newSession('s', T0, false);
    expect(toUpdate(s, { ...base, now: T0 + 30 * HOUR, answer: answer({ minutes: 1800 }) })?.minutes).toBe(1440);
    expect(toUpdate(s, { ...base, now: T0 + HOUR, answer: answer({ minutes: 12.7 }) })?.minutes).toBe(12);
    expect(toUpdate(s, { ...base, now: T0 + HOUR, answer: answer({ minutes: -5, note: 'x' }) })?.minutes).toBe(0);
    expect(toUpdate(s, { ...base, now: T0 + HOUR, answer: answer({ minutes: 5, note: 'x'.repeat(2500) }) })?.note).toHaveLength(2000);
  });
});

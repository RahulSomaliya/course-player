import { describe, expect, it } from 'vitest';
import type { JourneySession } from '../../../shared/types';
import { newSession, type StudySession } from './session';
import { OVER_DAY, describeSession, parseTime, prefillTime, sentDetail, timeProblem } from './signoff';
import { sampleCourse } from './test-fixtures';

const c = sampleCourse(); // §01 Welcome · §02 Part 1 intro · §03 Components
const START = new Date(2026, 9, 5, 9, 14).getTime(); // Mon 5 Oct, 9:14 am
const session = (over: Partial<StudySession> = {}): StudySession => ({ ...newSession('s', START, false), ...over });
const lectures = (n: number) => Array.from({ length: n }, (_, i) => ({ section: 3, lecture: i + 1, title: `Lecture ${i + 1}` }));

describe('describeSession (the top of the sign-off card, spec v3 A5)', () => {
  it('"1h 23m · started 9:14 am", the section she spent the most player time in, the lectures', () => {
    const s = session({ sectionSeconds: { 3: 600, 1: 60 }, lecturesCompleted: lectures(2) });
    expect(describeSession(s, c, START + 83 * 60_000)).toEqual({
      timer: '1h 23m',
      started: '9:14 am',
      section: '§03 Components',
      lectures: { shown: ['Lecture 1', 'Lecture 2'], more: 0 },
      overDay: false,
    });
  });

  it('started on another day → the date too; over 24 h → overDay (the card asks for the real time)', () => {
    const d = describeSession(session(), c, new Date(2026, 9, 6, 10, 0).getTime());
    expect(d).toMatchObject({ timer: '24h 46m', started: 'Mon 5 Oct, 9:14 am', overDay: true });
  });

  it('titles stay compact: 5 at most, then "+N more"; no player time → no section', () => {
    const d = describeSession(session({ lecturesCompleted: lectures(9) }), c, START + 60_000);
    expect(d.lectures).toEqual({ shown: ['Lecture 1', 'Lecture 2', 'Lecture 3', 'Lecture 4', 'Lecture 5'], more: 4 });
    expect(d.section).toBeNull();
  });

  it('a part introduction reads as its part', () => {
    expect(describeSession(session({ sectionSeconds: { 2: 600 } }), c, START + 60_000).section).toBe('Part 1 · Fundamentals');
  });
});

describe('the Time studied fields (hours + minutes, max = the timer, ≤ 24 h)', () => {
  it('parseTime: empty = 0; anything but digits is not a time', () => {
    expect(parseTime('1', '23')).toBe(83);
    expect(parseTime('', '45')).toBe(45);
    expect(parseTime('', '')).toBe(0);
    expect(parseTime('1.5', '0')).toBeNull();
    expect(parseTime('1', 'x')).toBeNull();
  });

  it('timeProblem: inline, in her words — never above the timer, never above a day, minutes 0–59', () => {
    expect(timeProblem(83, 83)).toBeNull();
    expect(timeProblem(0, 83)).toBeNull(); // 0 + a note is a valid update; Send explains when there is no note
    expect(timeProblem(84, 83)).toBe('That’s more than the timer (1h 23m).');
    expect(timeProblem(1441, 2000)).toBe('At most 24h in one update.');
    expect(timeProblem(null, 83)).toBe('Use whole hours and minutes.');
  });

  // Review 2026-10-05: "24h 0m" prefilled for a timer left running over a weekend — one tap credited a day.
  it('prefillTime: the timer, rounded down — EMPTY for a timer over 24 h, and Send waits for her real time', () => {
    expect(prefillTime(session(), START + 83 * 60_000 + 59_000)).toEqual({ hours: '1', minutes: '23' });
    expect(prefillTime(session(), START + 24 * 3_600_000)).toEqual({ hours: '24', minutes: '0' }); // exactly a day is not over
    expect(prefillTime(session(), START + 63 * 3_600_000)).toEqual({ hours: '', minutes: '' });
    expect(OVER_DAY).toBe('The timer ran longer than a day — set the real time.');
    expect(timeProblem(0, 3780, true)).toBe(OVER_DAY); // untouched: whatever the fields read
    expect(timeProblem(60, 3780)).toBeNull(); // once she typed it
  });
});

describe('sentDetail (the confirmation under "Sent to Rahul ✓")', () => {
  const u = (over: Partial<JourneySession>): Pick<JourneySession, 'minutes' | 'note' | 'stuck'> => ({ minutes: 83, note: null, stuck: false, ...over });
  it('"1h 23m logged · note included"', () => {
    expect(sentDetail(u({ note: 'hi' }))).toBe('1h 23m logged · note included');
    expect(sentDetail(u({}))).toBe('1h 23m logged');
    expect(sentDetail(u({ minutes: 0, note: 'hi', stuck: true }))).toBe('Note included · marked stuck');
  });
});

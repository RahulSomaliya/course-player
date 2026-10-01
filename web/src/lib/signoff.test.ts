import { describe, expect, it } from 'vitest';
import type { LiveSession } from './session';
import { describeTarget } from './signoff';
import { sampleCourse } from './test-fixtures';

const c = sampleCourse(); // §01 Welcome · §02 Part 1 intro · §03 Components
const NOW = new Date(2026, 9, 1, 21, 0).getTime(); // Thu 1 Oct, 21:00
const session = (over: Partial<LiveSession> = {}): LiveSession => ({
  id: 's',
  startedAt: new Date(2026, 9, 1, 19, 0).getTime(),
  lastStudyAt: new Date(2026, 9, 1, 20, 12).getTime(),
  seconds: 72 * 60,
  sectionSeconds: { 3: 72 * 60 },
  lecturesCompleted: [],
  finishedSections: [],
  ...over,
});
const lectures = (n: number) => Array.from({ length: n }, (_, i) => ({ section: 3, lecture: i + 1, title: `Lecture ${i + 1}` }));

describe('describeTarget (the auto summary at the top of the sign-off card)', () => {
  it('this session: warm heading, time, lectures, section', () => {
    expect(describeTarget({ kind: 'live', session: session({ lecturesCompleted: lectures(2) }) }, c, 'Mansi', NOW)).toEqual({
      heading: 'Nice work, Mansi',
      question: null,
      studied: '1h 12m',
      section: '§03 Components',
      lectures: { shown: ['Lecture 1', 'Lecture 2'], more: 0 },
      needsNote: false,
    });
  });

  it('titles stay compact: 5 at most, then "+N more"', () => {
    expect(describeTarget({ kind: 'live', session: session({ lecturesCompleted: lectures(9) }) }, c, 'Mansi', NOW).lectures).toEqual({
      shown: ['Lecture 1', 'Lecture 2', 'Lecture 3', 'Lecture 4', 'Lecture 5'],
      more: 4,
    });
  });

  it('an earlier session: "You studied 1h 12m on Tue — add a note for Rahul?"', () => {
    const tue = session({ startedAt: new Date(2026, 8, 29, 19, 0).getTime(), lastStudyAt: new Date(2026, 8, 29, 20, 12).getTime() });
    expect(describeTarget({ kind: 'pending', session: tue }, c, 'Mansi', NOW)).toMatchObject({
      heading: 'You studied 1h 12m on Tue',
      question: 'Add a note for Rahul?',
    });
    expect(describeTarget({ kind: 'pending', session: session() }, c, 'Mansi', NOW).heading).toBe('You studied 1h 12m earlier today');
    const yesterday = session({ startedAt: new Date(2026, 8, 30, 19, 0).getTime() });
    expect(describeTarget({ kind: 'pending', session: yesterday }, c, 'Mansi', NOW).heading).toBe('You studied 1h 12m yesterday');
    const old = session({ startedAt: new Date(2026, 8, 20, 19, 0).getTime() });
    expect(describeTarget({ kind: 'pending', session: old }, c, 'Mansi', NOW).heading).toBe('You studied 1h 12m on 20 Sep');
  });

  it('under 5 min: only sent with a note', () => {
    expect(describeTarget({ kind: 'live', session: session({ seconds: 240 }) }, c, 'Mansi', NOW)).toMatchObject({ studied: '4m', needsNote: true });
  });

  it('nothing studied in the player: a note for Rahul', () => {
    expect(describeTarget({ kind: 'note' }, c, 'Mansi', NOW)).toEqual({
      heading: 'A note for Rahul',
      question: null,
      studied: null,
      section: null,
      lectures: { shown: [], more: 0 },
      needsNote: true,
    });
  });

  it('a part introduction reads as its part', () => {
    expect(describeTarget({ kind: 'live', session: session({ sectionSeconds: { 2: 600 } }) }, c, 'Mansi', NOW).section).toBe('Part 1 · Fundamentals');
  });
});

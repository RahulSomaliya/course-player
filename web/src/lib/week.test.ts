import { describe, expect, it } from 'vitest';
import type { JourneyStatus } from '../../../shared/types';
import { describeWeek, dueStat, projectionLine } from './week';

const status = (over: Partial<JourneyStatus> = {}): JourneyStatus => ({
  pace: 'on-track',
  daysDelta: 0,
  week: 3,
  totalWeeks: 10,
  targetDate: '2026-12-25',
  deadline: '2027-01-01',
  goal: { sectionNumber: 12, title: 'Effects and Data Fetching', due: '2026-10-23' },
  coachNote: null,
  planBreak: null,
  sectionDue: {},
  skippedSections: [4],
  studyWeekdays: [1, 2, 3, 4, 5],
  planBreaks: [],
  ...over,
});
const diwali = { label: 'Diwali break', start: '2026-11-01', end: '2026-11-15' };

describe('describeWeek ("This week")', () => {
  it('week, goal and pace — not the course due date (the Due stat right below shows it)', () => {
    expect(describeWeek(status(), '2026-10-21')).toEqual({
      week: 'Week 3 of 10',
      goal: { text: 'Finish 12 Effects and Data Fetching', due: 'Fri 23 Oct' }, // v4: never "§12"
      pace: { label: 'On track', tone: 'good' },
      onBreak: null,
      upcomingBreak: null,
    });
  });
  it('ahead / behind by N days (singular too) — never a bare "Ahead" / "Behind"', () => {
    expect(describeWeek(status({ pace: 'ahead', daysDelta: 2 }), '2026-10-21').pace).toEqual({ label: 'Ahead by 2 days', tone: 'good' });
    expect(describeWeek(status({ pace: 'behind', daysDelta: -1 }), '2026-10-21').pace).toEqual({ label: 'Behind by 1 day', tone: 'quiet' });
    // JS Journey review 2026-10-01: a status from before its one-model fix paired "behind" with 0 days —
    // a bare "Behind" topped the page while the plan said on schedule. The days decide (JS Journey paceLabel).
    expect(describeWeek(status({ pace: 'ahead', daysDelta: 0 }), '2026-10-21').pace).toEqual({ label: 'On track', tone: 'good' });
    expect(describeWeek(status({ pace: 'behind', daysDelta: 0 }), '2026-10-21').pace).toEqual({ label: 'On track', tone: 'good' });
  });
  it('no goal → no goal line', () => {
    expect(describeWeek(status({ goal: null }), '2026-10-21').goal).toBeNull();
  });
  it('during a break: "Diwali break · back Mon 16 Nov" instead of a pace (last day included)', () => {
    for (const today of ['2026-11-01', '2026-11-03', '2026-11-15']) {
      const w = describeWeek(status({ planBreak: diwali }), today);
      expect(w.pace).toBeNull();
      expect(w.onBreak).toEqual({ label: 'Diwali break', back: 'Mon 16 Nov' });
    }
  });
  it('an upcoming break is a quiet line under the pace', () => {
    const w = describeWeek(status({ planBreak: diwali }), '2026-10-24');
    expect(w.pace?.label).toBe('On track');
    expect(w.upcomingBreak).toBe('Diwali break from Sun 1 Nov to Sun 15 Nov');
  });
  it('a JS Journey deployed before planBreak existed still renders', () => {
    const { planBreak: _omit, ...old } = status();
    expect(describeWeek(old as JourneyStatus, '2026-10-21').onBreak).toBeNull();
  });
});

describe('dueStat (replaces the finish projection)', () => {
  it('the course target date + the pace pill\'s own words (one label, never a bare word)', () => {
    expect(dueStat(status(), '2026-10-21')).toEqual({ value: 'Fri 25 Dec', hint: 'On track' });
    expect(dueStat(status({ pace: 'ahead', daysDelta: 3 }), '2026-10-21')?.hint).toBe('Ahead by 3 days');
    expect(dueStat(status({ pace: 'behind', daysDelta: -2 }), '2026-10-21')?.hint).toBe('Behind by 2 days');
    expect(dueStat(status({ pace: 'behind', daysDelta: 0 }), '2026-10-21')?.hint).toBe('On track');
  });
  it('on a break: the break, not a pace', () => {
    expect(dueStat(status({ planBreak: diwali }), '2026-11-03')?.hint).toBe('Diwali break');
  });
  it('no status (not connected, nothing cached) → omitted', () => {
    expect(dueStat(null, '2026-10-21')).toBeNull();
  });
});

// v4 (docs/spec-v4-pace-and-coach.md "Projection"): where her CURRENT pace lands, in words. SAME TABLE,
// VERBATIM, as JS Journey tests/journey-view.test.ts PROJECTION_CASES (its lib/journey-view.ts projectionLine;
// the "her" rows are its coach page's — the player says "you"). Curly apostrophes ("you’ll"). vsTarget is in
// study days (+ = before the target): |vsTarget| < 3 → "right around"; ≥ 5 → weeks (5 study days a week,
// rounded); else days. Change both together.
type Projection = { finish: string; studyDaysLeft: number; minutesPerStudyDay: number; vsTarget: number };
const P = (vsTarget: number, minutesPerStudyDay = 85, finish = '2026-11-27'): Projection => ({ finish, studyDaysLeft: 30, minutesPerStudyDay, vsTarget });
const PROJECTION_CASES: { name: string; p: Projection; who: 'you' | 'her'; want: string }[] = [
  { name: 'weeks before (you)', p: P(20), who: 'you', want: 'At your pace — about 1h 25m of lectures a study day — you’ll finish around Fri 27 Nov, 4 weeks before your target.' },
  { name: 'weeks before (her)', p: P(20), who: 'her', want: 'At her pace — about 1h 25m of lectures a study day — she’ll finish around Fri 27 Nov, 4 weeks before her target.' },
  { name: 'on the target', p: P(0), who: 'you', want: 'At your pace — about 1h 25m of lectures a study day — you’ll finish around Fri 27 Nov, right around your target.' },
  { name: '2 days early is "right around"', p: P(2), who: 'you', want: 'At your pace — about 1h 25m of lectures a study day — you’ll finish around Fri 27 Nov, right around your target.' },
  { name: '2 days late is "right around"', p: P(-2), who: 'her', want: 'At her pace — about 1h 25m of lectures a study day — she’ll finish around Fri 27 Nov, right around her target.' },
  { name: '3 days before', p: P(3), who: 'you', want: 'At your pace — about 1h 25m of lectures a study day — you’ll finish around Fri 27 Nov, 3 days before your target.' },
  { name: '4 days after', p: P(-4), who: 'you', want: 'At your pace — about 1h 25m of lectures a study day — you’ll finish around Fri 27 Nov, 4 days after your target.' },
  { name: '5 study days = 1 week after', p: P(-5), who: 'her', want: 'At her pace — about 1h 25m of lectures a study day — she’ll finish around Fri 27 Nov, 1 week after her target.' },
  { name: '7 study days rounds to 1 week', p: P(7, 91, '2026-12-16'), who: 'her', want: 'At her pace — about 1h 31m of lectures a study day — she’ll finish around Wed 16 Dec, 1 week before her target.' },
  { name: '12 study days rounds to 2 weeks', p: P(-12), who: 'you', want: 'At your pace — about 1h 25m of lectures a study day — you’ll finish around Fri 27 Nov, 2 weeks after your target.' },
  { name: '13 study days rounds to 3 weeks', p: P(13), who: 'you', want: 'At your pace — about 1h 25m of lectures a study day — you’ll finish around Fri 27 Nov, 3 weeks before your target.' },
  { name: 'under an hour a day', p: P(20, 45), who: 'you', want: 'At your pace — about 45m of lectures a study day — you’ll finish around Fri 27 Nov, 4 weeks before your target.' },
  { name: 'a whole hour', p: P(20, 60), who: 'you', want: 'At your pace — about 1h of lectures a study day — you’ll finish around Fri 27 Nov, 4 weeks before your target.' },
];
// the "her" rows (the coach page's): the player's line with her words swapped in
const asHers = (you: string): string => you.replace('At your pace', 'At her pace').replace('you’ll', 'she’ll').replace('your target', 'her target');

describe('projectionLine (the quiet line at the bottom of This week)', () => {
  it.each(PROJECTION_CASES)('$name', ({ p, who, want }) => {
    const text = projectionLine(p)?.text ?? '';
    expect(who === 'you' ? text : asHers(text)).toBe(want);
  });
  it('the example status JS Journey sends today: 1h 31m a day, Wed 16 Dec, 7 study days early → 1 week', () => {
    expect(projectionLine({ finish: '2026-12-16', studyDaysLeft: 38, minutesPerStudyDay: 91, vsTarget: 7 })?.text).toBe(
      'At your pace — about 1h 31m of lectures a study day — you’ll finish around Wed 16 Dec, 1 week before your target.',
    );
  });
  it('the rate rounds like JS Journey fmtDur (whole minutes, never negative)', () => {
    expect(projectionLine(P(0, 42.4))?.lead).toBe('At your pace — about 42m of lectures a study day — you’ll finish around ');
    expect(projectionLine(P(0, 89.6))?.lead).toBe('At your pace — about 1h 30m of lectures a study day — you’ll finish around ');
  });
  it('splits around the date, so the date can be the one strong word', () => {
    expect(projectionLine(P(20))).toEqual({
      lead: 'At your pace — about 1h 25m of lectures a study day — you’ll finish around ',
      date: 'Fri 27 Nov',
      tail: ', 4 weeks before your target.',
      text: 'At your pace — about 1h 25m of lectures a study day — you’ll finish around Fri 27 Nov, 4 weeks before your target.',
    });
  });
  it('no projection yet (null), or a JS Journey without it (undefined) → no line', () => {
    expect(projectionLine(null)).toBeNull();
    expect(projectionLine(undefined)).toBeNull();
  });
});

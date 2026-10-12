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

// v4 (docs/spec-v4-pace-and-coach.md "Projection"): where her CURRENT pace lands, in words. SAME TABLE as
// JS Journey lib/journey-view.ts (its coach line says "her" / "she'll") — change both together.
// vsTarget is in study days (+ = before the target): |vsTarget| < 3 → "right around"; ≥ 5 → weeks
// (5 study days a week, rounded); else days.
const P = { finish: '2026-11-27', studyDaysLeft: 30, minutesPerStudyDay: 85 };
const LEAD = "At your pace — about 1h 25m of lectures a study day — you'll finish around Fri 27 Nov";
const PROJECTION_CASES: { name: string; minutes?: number; vsTarget: number; want: string }[] = [
  { name: 'the spec example: 20 study days early → 4 weeks before', vsTarget: 20, want: `${LEAD}, 4 weeks before your target.` },
  { name: 'right on it', vsTarget: 0, want: `${LEAD}, right around your target.` },
  { name: '2 days early is still "right around"', vsTarget: 2, want: `${LEAD}, right around your target.` },
  { name: '2 days late is still "right around"', vsTarget: -2, want: `${LEAD}, right around your target.` },
  { name: '3 days early → days', vsTarget: 3, want: `${LEAD}, 3 days before your target.` },
  { name: '4 days late → days', vsTarget: -4, want: `${LEAD}, 4 days after your target.` },
  { name: '5 study days → 1 week', vsTarget: 5, want: `${LEAD}, 1 week before your target.` },
  { name: '7 study days rounds to 1 week', vsTarget: -7, want: `${LEAD}, 1 week after your target.` },
  { name: '8 study days rounds to 2 weeks', vsTarget: 8, want: `${LEAD}, 2 weeks before your target.` },
  { name: 'the spec example after: 10 study days late → 2 weeks after', vsTarget: -10, want: `${LEAD}, 2 weeks after your target.` },
  {
    name: 'the rate in whole minutes, under an hour',
    minutes: 42.4,
    vsTarget: 0,
    want: "At your pace — about 42m of lectures a study day — you'll finish around Fri 27 Nov, right around your target.",
  },
  {
    name: 'a whole number of hours',
    minutes: 120,
    vsTarget: 0,
    want: "At your pace — about 2h of lectures a study day — you'll finish around Fri 27 Nov, right around your target.",
  },
];

describe('projectionLine (the quiet line at the bottom of This week)', () => {
  it.each(PROJECTION_CASES)('$name', ({ minutes, vsTarget, want }) => {
    expect(projectionLine({ ...P, minutesPerStudyDay: minutes ?? P.minutesPerStudyDay, vsTarget })?.text).toBe(want);
  });
  it('splits around the date, so the date can be the one strong word', () => {
    expect(projectionLine({ ...P, vsTarget: 20 })).toEqual({
      lead: "At your pace — about 1h 25m of lectures a study day — you'll finish around ",
      date: 'Fri 27 Nov',
      tail: ', 4 weeks before your target.',
      text: `${LEAD}, 4 weeks before your target.`,
    });
  });
  it('no projection yet (null), or a JS Journey without it (undefined) → no line', () => {
    expect(projectionLine(null)).toBeNull();
    expect(projectionLine(undefined)).toBeNull();
  });
});

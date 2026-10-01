import { describe, expect, it } from 'vitest';
import type { JourneyStatus } from '../../../shared/types';
import { describeWeek, dueStat } from './week';

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
      goal: { text: 'Finish §12 Effects and Data Fetching', due: 'Fri 23 Oct' },
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

import { describe, expect, it } from 'vitest';
import type { JourneyStatus } from '../../../shared/types';
import { describePlan } from './plan';

const status = (over: Partial<JourneyStatus> = {}): JourneyStatus => ({
  pace: 'on-track',
  daysDelta: 0,
  week: 3,
  totalWeeks: 10,
  targetDate: '2026-12-11',
  deadline: '2026-12-18',
  goal: { sectionNumber: 7, title: 'Thinking In React - State Management', due: '2026-10-16' },
  coachNote: null,
  planBreak: null,
  ...over,
});

describe('describePlan', () => {
  it('pace + week + goal', () => {
    expect(describePlan(status(), '2026-10-14')).toEqual({
      pace: { label: 'On track', tone: 'good' },
      line: 'Week 3 of 10 · Goal: finish §07 by Fri 16 Oct',
      breakLine: null,
      note: null,
    });
  });
  it('ahead / behind by N days (singular too)', () => {
    expect(describePlan(status({ pace: 'ahead', daysDelta: 2 }), '2026-10-14').pace).toEqual({ label: 'Ahead by 2 days', tone: 'good' });
    expect(describePlan(status({ pace: 'behind', daysDelta: -1 }), '2026-10-14').pace).toEqual({ label: 'Behind by 1 day', tone: 'quiet' });
    expect(describePlan(status({ pace: 'ahead', daysDelta: 0 }), '2026-10-14').pace?.label).toBe('Ahead');
  });
  it('no goal → just the week', () => {
    expect(describePlan(status({ goal: null }), '2026-10-14').line).toBe('Week 3 of 10');
  });
  it('during a break: says so warmly instead of a pace', () => {
    const p = describePlan(status({ planBreak: { label: 'Diwali break', start: '2026-11-01', end: '2026-11-15' } }), '2026-11-03');
    expect(p.pace).toBeNull();
    expect(p.breakLine).toEqual({ active: true, text: 'Diwali break · back on Mon 16 Nov' });
  });
  it('the last day of the break is still the break', () => {
    const p = describePlan(status({ planBreak: { label: 'Diwali break', start: '2026-11-01', end: '2026-11-15' } }), '2026-11-15');
    expect(p.breakLine?.active).toBe(true);
  });
  it('an upcoming break is a quiet line under the pace', () => {
    const p = describePlan(status({ planBreak: { label: 'Diwali break', start: '2026-11-01', end: '2026-11-15' } }), '2026-10-24');
    expect(p.pace).toEqual({ label: 'On track', tone: 'good' });
    expect(p.breakLine).toEqual({ active: false, text: 'Diwali break from Sun 1 Nov to Sun 15 Nov' });
  });
  it('an old JS Journey without planBreak still renders', () => {
    const { planBreak: _omit, ...old } = status();
    expect(describePlan(old as JourneyStatus, '2026-10-14').breakLine).toBeNull();
  });
  it('passes the latest coach note through', () => {
    const note = { body: 'Lovely week!', createdAt: '2026-10-10T10:00:00Z' };
    expect(describePlan(status({ coachNote: note }), '2026-10-14').note).toEqual(note);
  });
});

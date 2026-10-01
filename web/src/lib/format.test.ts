import { describe, expect, it } from 'vitest';
import { addDays, dayOfWeekLabel, daysBetween, localDateKey } from './dates';
import { formatClock, formatDay, formatDuration, formatShortDate } from './format';

describe('localDateKey', () => {
  it('uses the local calendar, so a late-night session lands on the right day', () => {
    expect(localDateKey(new Date(2026, 9, 1, 23, 59, 30))).toBe('2026-10-01');
    expect(localDateKey(new Date(2026, 9, 2, 0, 0, 1))).toBe('2026-10-02');
    expect(localDateKey(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('date-key arithmetic', () => {
  it('adds days across month and year ends', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('counts whole days between keys (DST-proof)', () => {
    expect(daysBetween('2026-10-01', '2026-10-01')).toBe(0);
    expect(daysBetween('2026-10-01', '2026-11-15')).toBe(45);
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2); // EU DST change weekend
    expect(daysBetween('2026-10-05', '2026-10-01')).toBe(-4);
  });
  it('names the weekday', () => {
    expect(dayOfWeekLabel('2026-09-29')).toBe('Tue');
    expect(dayOfWeekLabel('2026-11-16')).toBe('Mon');
  });
});

describe('formatClock', () => {
  it('formats player times', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(9.9)).toBe('0:09');
    expect(formatClock(751)).toBe('12:31');
    expect(formatClock(3723)).toBe('1:02:03');
  });
  it('never shows NaN for an unknown duration', () => {
    expect(formatClock(Number.NaN)).toBe('0:00');
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe('0:00');
  });
});

describe('formatDuration', () => {
  it('formats study time and course length', () => {
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(59)).toBe('0m');
    expect(formatDuration(60)).toBe('1m');
    expect(formatDuration(42 * 60 + 29)).toBe('42m');
    expect(formatDuration(72 * 60)).toBe('1h 12m');
    expect(formatDuration(2 * 3600)).toBe('2h');
    expect(formatDuration(241822)).toBe('67h 10m');
  });
});

describe('date labels', () => {
  it('formats a day for tooltips and goals', () => {
    expect(formatDay('2026-09-29')).toBe('Tue 29 Sep');
    expect(formatShortDate('2026-12-12')).toBe('12 Dec');
  });
  it('adds the year only when it is not the reference year (a far-off finish estimate)', () => {
    expect(formatShortDate('2026-12-12', '2026-10-01')).toBe('12 Dec');
    expect(formatShortDate('2027-01-08', '2026-10-01')).toBe('8 Jan 2027');
  });
});

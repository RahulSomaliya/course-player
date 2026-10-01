import { describe, expect, it } from 'vitest';
import { completion, last30, streak, studiedOn, studyCalendar, type StudyCalendar } from './stats';
import type { JourneyStatus } from '../../../shared/types';
import { progressWith, sampleCourse } from './test-fixtures';

describe('studiedOn (Today)', () => {
  it('reads the day, 0 when absent', () => {
    expect(studiedOn({ '2026-10-01': 300 }, '2026-10-01')).toBe(300);
    expect(studiedOn({}, '2026-10-01')).toBe(0);
  });
});

// The streak counts STUDY days (her plan: Mon–Fri, Diwali 1–15 Nov off). Walking back from today:
// ≥ 5 min adds 1 (weekends + break days too); a plan study day under 5 min ends it — except today,
// still in progress; a weekend / break day under 5 min is skipped. SAME TABLE as JS Journey
// tests/stats.test.ts (its lib/stats.ts mirrors this rule) — change both together.
const PLAN: StudyCalendar = { studyWeekdays: [1, 2, 3, 4, 5], breaks: [{ start: '2026-11-01', end: '2026-11-15' }] };
const M = 900; // a real study day
const STREAK_CASES: { name: string; days: Record<string, number>; today: string; want: number }[] = [
  { name: 'weekend gap: Thu + Fri, then Monday studied', days: { '2026-10-08': M, '2026-10-09': M, '2026-10-12': M }, today: '2026-10-12', want: 3 },
  { name: 'weekend gap: Monday not studied yet (today in progress)', days: { '2026-10-08': M, '2026-10-09': M }, today: '2026-10-12', want: 2 },
  { name: 'a Sunday with nothing is skipped', days: { '2026-10-08': M, '2026-10-09': M }, today: '2026-10-11', want: 2 },
  { name: 'weekend study adds', days: { '2026-10-09': M, '2026-10-10': 600, '2026-10-11': 300, '2026-10-12': M }, today: '2026-10-12', want: 4 },
  { name: 'missed Wednesday breaks it', days: { '2026-10-12': M, '2026-10-13': M, '2026-10-15': M }, today: '2026-10-15', want: 1 },
  { name: 'a study day under 5 min breaks it', days: { '2026-10-12': M, '2026-10-13': 299, '2026-10-14': M }, today: '2026-10-14', want: 1 },
  { name: 'yesterday (a study day) missed → 0', days: { '2026-10-12': M }, today: '2026-10-14', want: 0 },
  { name: 'today in progress under 5 min neither adds nor breaks', days: { '2026-10-12': M, '2026-10-13': 120 }, today: '2026-10-13', want: 1 },
  { name: 'today at 5 min adds', days: { '2026-10-12': M, '2026-10-13': 300 }, today: '2026-10-13', want: 2 },
  { name: 'Diwali gap: Thu 29 + Fri 30 Oct, then Mon 16 Nov', days: { '2026-10-29': M, '2026-10-30': M, '2026-11-16': M }, today: '2026-11-16', want: 3 },
  { name: 'during Diwali the streak holds', days: { '2026-10-29': M, '2026-10-30': M }, today: '2026-11-04', want: 2 },
  { name: 'study on a break day adds', days: { '2026-10-30': M, '2026-11-03': 1200 }, today: '2026-11-04', want: 2 },
  { name: 'missing the last study day before the break still breaks it', days: { '2026-10-29': M }, today: '2026-11-04', want: 0 },
  { name: 'crosses month ends', days: { '2026-09-30': M, '2026-10-01': M }, today: '2026-10-01', want: 2 },
  { name: 'fresh profile', days: {}, today: '2026-10-01', want: 0 },
];

describe('streak (study days)', () => {
  it.each(STREAK_CASES)('$name → $want', ({ days, today, want }) => {
    expect(streak(days, today, PLAN)).toBe(want);
  });
  it('nothing studied at all on a plan with no study days → 0 (the walk stops at the oldest study day)', () => {
    expect(streak({}, '2026-10-14', { studyWeekdays: [], breaks: [] })).toBe(0);
    expect(streak({ '2026-10-05': M, '2026-10-09': M }, '2026-10-14', { studyWeekdays: [], breaks: [] })).toBe(2);
  });
});

describe('studyCalendar (the plan the streak walks)', () => {
  it('reads the study weekdays + every break from her JS Journey status', () => {
    const diwali = { label: 'Diwali', start: '2026-11-01', end: '2026-11-15' };
    const status: JourneyStatus = {
      pace: 'on-track',
      daysDelta: 0,
      week: 5,
      totalWeeks: 12,
      targetDate: '2026-12-25',
      deadline: '2027-01-01',
      goal: null,
      coachNote: null,
      planBreak: null, // only the current / next one — the streak needs every break (planBreaks)
      sectionDue: {},
      skippedSections: [4],
      studyWeekdays: [1, 2, 3, 4, 5, 6],
      planBreaks: [diwali],
    };
    expect(studyCalendar(status)).toEqual({
      studyWeekdays: [1, 2, 3, 4, 5, 6],
      breaks: [diwali],
    });
  });
  it('no status (not connected, nothing cached): Mon–Fri, no breaks', () => {
    expect(studyCalendar(null)).toEqual({ studyWeekdays: [1, 2, 3, 4, 5], breaks: [] });
    // without the plan, a Diwali weekday counts as missed — the cost of never having connected
    expect(streak({ '2026-10-30': M }, '2026-11-04', studyCalendar(null))).toBe(0);
  });
});

describe('completion', () => {
  const c = sampleCourse(); // videos: 3x600 + 60 + 2x1200 = 4260 s; 7 lectures
  it('is 0 for a fresh profile', () => {
    expect(completion(c, {})).toEqual({ percent: 0, doneLectures: 0, totalLectures: 7 });
  });
  it('% of video duration done; n counts every lecture kind', () => {
    const ids = c.sections.flatMap((s) => s.lectures.map((l) => l.id));
    const p = progressWith({
      [ids[0] as string]: { done: true }, // 600
      [ids[4] as string]: { done: true }, // article: counts as a lecture, adds no duration
      [ids[5] as string]: { done: true }, // 1200
      [ids[1] as string]: { pos: 500 }, // partly watched does not count
    });
    const r = completion(c, p.lectures);
    expect(r.doneLectures).toBe(3);
    expect(r.percent).toBeCloseTo((1800 / 4260) * 100, 5);
  });
});

describe('last30', () => {
  it('returns 30 days ending today, oldest first, zeros filled', () => {
    const r = last30({ '2026-10-01': 600, '2026-09-02': 1200, '2026-09-01': 9999 }, '2026-10-01');
    expect(r.days).toHaveLength(30);
    expect(r.days[0]).toEqual({ key: '2026-09-02', seconds: 1200 });
    expect(r.days[29]).toEqual({ key: '2026-10-01', seconds: 600 });
    expect(r.days[15]?.seconds).toBe(0);
  });
  it('averages across all 30 days', () => {
    expect(last30({ '2026-10-01': 1800, '2026-09-30': 1800 }, '2026-10-01').average).toBe(120);
    expect(last30({}, '2026-10-01').average).toBe(0);
  });
});

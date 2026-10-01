import { describe, expect, it } from 'vitest';
import { completion, last30, streak, studiedOn, timeLeft } from './stats';
import { progressWith, sampleCourse } from './test-fixtures';

const at = (key: string, hour = 12): number => {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d, hour).getTime();
};

describe('studiedOn (Today)', () => {
  it('reads the day, 0 when absent', () => {
    expect(studiedOn({ '2026-10-01': 300 }, '2026-10-01')).toBe(300);
    expect(studiedOn({}, '2026-10-01')).toBe(0);
  });
});

describe('streak', () => {
  it('counts consecutive days of >= 5 min ending today', () => {
    expect(streak({ '2026-09-29': 300, '2026-09-30': 900, '2026-10-01': 3600 }, '2026-10-01')).toBe(3);
  });
  it('still counts when the streak ends yesterday (today not studied yet)', () => {
    expect(streak({ '2026-09-29': 300, '2026-09-30': 900 }, '2026-10-01')).toBe(2);
  });
  it('a short today (< 5 min) does not break a streak that ends yesterday', () => {
    expect(streak({ '2026-09-30': 900, '2026-10-01': 120 }, '2026-10-01')).toBe(1);
  });
  it('is 0 when the last study day was before yesterday', () => {
    expect(streak({ '2026-09-28': 3600 }, '2026-10-01')).toBe(0);
  });
  it('a gap day or a < 5 min day ends the run', () => {
    expect(streak({ '2026-09-27': 900, '2026-09-29': 900, '2026-09-30': 900 }, '2026-09-30')).toBe(2);
    expect(streak({ '2026-09-28': 900, '2026-09-29': 299, '2026-09-30': 900 }, '2026-09-30')).toBe(1);
  });
  it('crosses month ends', () => {
    expect(streak({ '2026-09-30': 900, '2026-10-01': 900 }, '2026-10-01')).toBe(2);
  });
  it('is 0 for a fresh profile', () => {
    expect(streak({}, '2026-10-01')).toBe(0);
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

describe('timeLeft', () => {
  const c = sampleCourse();
  const ids = c.sections.flatMap((s) => s.lectures.map((l) => l.id));
  it('remaining video time with no pace yet → eta null', () => {
    expect(timeLeft(c, {}, {}, '2026-10-01')).toEqual({ remaining: 4260, eta: null });
  });
  it('projects a finish date from the content pace of the last 14 days', () => {
    // 1800 s of content finished over a 14-day window → 1800/14 s a day; 2460 s left → ceil(19.13) = 20 days
    const days: Record<string, number> = { '2026-09-18': 3600 }; // first study day 14 days back
    const p = progressWith({
      [ids[0] as string]: { done: true, doneAt: at('2026-09-20') },
      [ids[5] as string]: { done: true, doneAt: at('2026-10-01') },
    });
    const r = timeLeft(c, p.lectures, days, '2026-10-01');
    expect(r.remaining).toBe(4260 - 1800);
    expect(r.eta).toBe('2026-10-21');
  });
  it('ignores content finished before the 14-day window', () => {
    const p = progressWith({ [ids[0] as string]: { done: true, doneAt: at('2026-09-01') } });
    expect(timeLeft(c, p.lectures, { '2026-09-01': 900 }, '2026-10-01').eta).toBeNull();
  });
  it('a learner who started 2 days ago is measured over 2 days, not 14', () => {
    const p = progressWith({ [ids[5] as string]: { done: true, doneAt: at('2026-10-01') } }); // 1200 s
    // window = 2 days (30 Sep + 1 Oct) → 600 s/day; 3060 s left → 6 days
    const r = timeLeft(c, p.lectures, { '2026-09-30': 600, '2026-10-01': 1800 }, '2026-10-01');
    expect(r.eta).toBe('2026-10-07');
  });
  it('is zero with no eta once everything is done', () => {
    const all = Object.fromEntries(ids.map((id) => [id, { pos: 0, done: true, doneAt: at('2026-10-01') }]));
    expect(timeLeft(c, all, { '2026-10-01': 9000 }, '2026-10-01')).toEqual({ remaining: 0, eta: null });
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

import { describe, expect, it } from 'vitest';
import { indexCourse } from './course';
import { SNAPSHOT_DAYS, SNAPSHOT_EVERY_MS, buildSnapshot, nextPushDelay } from './snapshot';
import { progressWith, sampleCourse } from './test-fixtures';

const c = sampleCourse(); // 01: 3×600 s · 02 (Part 1): 60 s video + article · 03: 2×1200 s
const idx = indexCourse(c);
const ids = c.sections.flatMap((s) => s.lectures.map((l) => l.id));
const id = (i: number): string => ids[i] as string;
const NOW = new Date(2026, 9, 1, 20, 0).getTime();

describe('buildSnapshot (the coach sees exactly her numbers)', () => {
  it('a fresh learner: zeros, first lecture as current', () => {
    expect(buildSnapshot(c, idx, progressWith({}), NOW)).toEqual({
      course: 'test-course',
      takenAt: NOW,
      lecturesDone: 0,
      lecturesTotal: 7,
      videoSecondsDone: 0,
      videoSecondsTotal: 4260,
      sectionsDone: [],
      current: { sectionNumber: 1, lectureNumber: 1, title: 'Intro' },
      days: {},
    });
  });

  it('counts done lectures of every kind, video seconds of done videos, and 100% sections', () => {
    const p = progressWith(
      {
        [id(0)]: { done: true },
        [id(1)]: { done: true },
        [id(2)]: { done: true },
        [id(4)]: { done: true }, // the article: a lecture, no video seconds
        [id(5)]: { pos: 300 },
      },
      { lastLectureId: id(5), days: { '2026-10-01': 1800.4 } },
    );
    const s = buildSnapshot(c, idx, p, NOW);
    expect(s.lecturesDone).toBe(4);
    expect(s.videoSecondsDone).toBe(1800);
    expect(s.sectionsDone).toEqual([1]);
    expect(s.current).toEqual({ sectionNumber: 3, lectureNumber: 1, title: 'Props' });
    expect(s.days).toEqual({ '2026-10-01': 1800 });
  });

  it('keeps only the last 120 days of study time (whole seconds, no empty days)', () => {
    const p = progressWith({}, { days: { '2026-10-01': 60, '2026-06-04': 900, '2026-06-03': 900, '2026-09-01': 0 } });
    const days = buildSnapshot(c, idx, p, NOW).days;
    expect(SNAPSHOT_DAYS).toBe(120);
    expect(days).toEqual({ '2026-10-01': 60, '2026-06-04': 900 }); // 4 Jun = 119 days before 1 Oct
  });

  it('current is null once the whole course is done', () => {
    const all = Object.fromEntries(ids.map((x) => [x, { done: true }]));
    expect(buildSnapshot(c, idx, progressWith(all), NOW).current).toBeNull();
  });
});

describe('nextPushDelay (≤ 1 progress push per 5 min)', () => {
  it('first change: soon, after a short quiet delay', () => {
    expect(nextPushDelay(null, NOW)).toBe(10_000);
  });
  it('waits out the 5 min since the last push', () => {
    expect(SNAPSHOT_EVERY_MS).toBe(5 * 60_000);
    expect(nextPushDelay(NOW - 60_000, NOW)).toBe(4 * 60_000);
  });
  it('long after the last push: the short quiet delay again', () => {
    expect(nextPushDelay(NOW - 60 * 60_000, NOW)).toBe(10_000);
  });
});

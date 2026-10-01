import { describe, expect, it } from 'vitest';
import { indexCourse, isSectionDone, neighbours, nextLecture, sectionProgress } from './course';
import { progressWith, sampleCourse } from './test-fixtures';

const c = sampleCourse();
const ids = c.sections.flatMap((s) => s.lectures.map((l) => l.id));
const id = (i: number): string => ids[i] as string;

describe('indexCourse', () => {
  it('flattens lectures in course order with their section', () => {
    const idx = indexCourse(c);
    expect(idx.order).toEqual(ids);
    expect(idx.byId.get(id(5))?.section.number).toBe(3);
    expect(idx.byId.get(id(5))?.position).toBe(5);
  });
});

describe('nextLecture (Continue)', () => {
  const idx = indexCourse(c);
  it('fresh profile → the first lecture', () => {
    expect(nextLecture(idx, progressWith({}))).toBe(id(0));
  });
  it('the last lecture you touched, while unfinished', () => {
    expect(nextLecture(idx, progressWith({ [id(3)]: { pos: 30 } }, { lastLectureId: id(3) }))).toBe(id(3));
  });
  it('once the last touched is done → the next not-done lecture after it', () => {
    const p = progressWith({ [id(3)]: { done: true }, [id(4)]: { done: true } }, { lastLectureId: id(3) });
    expect(nextLecture(idx, p)).toBe(id(5));
  });
  it('wraps to the first not-done lecture when everything after is done', () => {
    const p = progressWith({ [id(5)]: { done: true }, [id(6)]: { done: true } }, { lastLectureId: id(6) });
    expect(nextLecture(idx, p)).toBe(id(0));
  });
  it('a stale lastLectureId (renamed file) falls back to the first not-done', () => {
    const p = progressWith({ [id(0)]: { done: true } }, { lastLectureId: 'gone.mp4' });
    expect(nextLecture(idx, p)).toBe(id(1));
  });
  it('null when the whole course is done', () => {
    const all = Object.fromEntries(ids.map((x) => [x, { done: true }]));
    expect(nextLecture(idx, progressWith(all, { lastLectureId: id(2) }))).toBeNull();
  });
});

describe('neighbours', () => {
  const idx = indexCourse(c);
  it('previous/next in course order across sections', () => {
    expect(neighbours(idx, id(2))).toEqual({ prev: id(1), next: id(3) });
    expect(neighbours(idx, id(0))).toEqual({ prev: null, next: id(1) });
    expect(neighbours(idx, id(6))).toEqual({ prev: id(5), next: null });
    expect(neighbours(idx, 'nope')).toEqual({ prev: null, next: null });
  });
});

describe('section progress', () => {
  it('counts done lectures', () => {
    const s = c.sections[0]!;
    const p = progressWith({ [id(0)]: { done: true }, [id(1)]: { pos: 100 } });
    expect(sectionProgress(s, p.lectures)).toEqual({ done: 1, total: 3 });
    expect(isSectionDone(s, p.lectures)).toBe(false);
    const all = progressWith({ [id(0)]: { done: true }, [id(1)]: { done: true }, [id(2)]: { done: true } });
    expect(isSectionDone(s, all.lectures)).toBe(true);
  });
});

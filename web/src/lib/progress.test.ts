import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFS,
  emptyProgress,
  isProgressState,
  pickNewer,
  withDone,
  withLast,
  withPos,
  withPrefs,
  withStudy,
} from './progress';

describe('pickNewer (LWW between localStorage and the SSD copy)', () => {
  const a = { ...emptyProgress(), updatedAt: 100 };
  const b = { ...emptyProgress(), updatedAt: 200 };
  it('adopts whichever has the larger updatedAt', () => {
    expect(pickNewer(a, b)).toBe(b);
    expect(pickNewer(b, a)).toBe(b);
  });
  it('a tie keeps the local copy', () => {
    const b2 = { ...b };
    expect(pickNewer(b, b2)).toBe(b);
  });
  it('handles a missing side', () => {
    expect(pickNewer(null, a)).toBe(a);
    expect(pickNewer(a, null)).toBe(a);
    expect(pickNewer(null, null)).toBeNull();
  });
});

describe('isProgressState', () => {
  it('accepts a valid state and rejects junk from a corrupted store', () => {
    expect(isProgressState(emptyProgress())).toBe(true);
    expect(isProgressState({ ...emptyProgress(), v: 2 })).toBe(false);
    expect(isProgressState({ ...emptyProgress(), lectures: { x: { pos: -1, done: false, doneAt: null } } })).toBe(false);
    expect(isProgressState({ ...emptyProgress(), prefs: { ...DEFAULT_PREFS, theme: 'blue' } })).toBe(false);
    expect(isProgressState('{}')).toBe(false);
  });
});

describe('mutations stamp updatedAt and never mutate', () => {
  const s0 = emptyProgress();
  it('withPos rounds to 0.1 s (keeps the keepalive body small)', () => {
    const s = withPos(s0, 'a.mp4', 12.3456, 1000);
    expect(s.lectures['a.mp4']).toEqual({ pos: 12.3, done: false, doneAt: null });
    expect(s.updatedAt).toBe(1000);
    expect(s0.lectures).toEqual({});
  });
  it('withDone sets doneAt once and clears it when undone', () => {
    let s = withDone(s0, 'a.mp4', true, 5000);
    expect(s.lectures['a.mp4']).toEqual({ pos: 0, done: true, doneAt: 5000 });
    s = withDone(s, 'a.mp4', true, 9000);
    expect(s.lectures['a.mp4']?.doneAt).toBe(5000);
    s = withDone(s, 'a.mp4', false, 9500);
    expect(s.lectures['a.mp4']).toEqual({ pos: 0, done: false, doneAt: null });
  });
  it('withDone keeps the position', () => {
    const s = withDone(withPos(s0, 'a.mp4', 40, 1), 'a.mp4', true, 2);
    expect(s.lectures['a.mp4']?.pos).toBe(40);
  });
  it('withStudy adds to the day', () => {
    let s = withStudy(s0, '2026-10-01', 3, 1);
    s = withStudy(s, '2026-10-01', 2, 2);
    expect(s.days).toEqual({ '2026-10-01': 5 });
  });
  it('withLast and withPrefs', () => {
    expect(withLast(s0, 'b.mp4', 7).lastLectureId).toBe('b.mp4');
    expect(withPrefs(s0, { rate: 1.5 }, 7).prefs).toEqual({ ...DEFAULT_PREFS, rate: 1.5 });
  });
  it('a no-op change returns the same object (no needless save)', () => {
    const s = withLast(s0, 'b.mp4', 7);
    expect(withLast(s, 'b.mp4', 8)).toBe(s);
    expect(withPrefs(s, { rate: DEFAULT_PREFS.rate }, 8)).toBe(s);
    expect(withDone(s, 'zzz', false, 8)).toBe(s);
  });
});

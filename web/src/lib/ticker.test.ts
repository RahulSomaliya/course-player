import { describe, expect, it } from 'vitest';
import { IDLE_INPUT_MS, StudyTicker, isStudying } from './ticker';

describe('isStudying', () => {
  const base = { playing: false, reading: false, visible: true, lastInputAt: 0, now: 1000 };
  it('a playing video counts, even in a hidden tab', () => {
    expect(isStudying({ ...base, playing: true, visible: false, lastInputAt: -1e9 })).toBe(true);
  });
  it('an open article counts while visible with input in the last 3 min', () => {
    expect(isStudying({ ...base, reading: true, now: IDLE_INPUT_MS - 1 })).toBe(true);
  });
  it('an article stops counting after 3 min without input', () => {
    expect(isStudying({ ...base, reading: true, now: IDLE_INPUT_MS + 1 })).toBe(false);
  });
  it('an article in a hidden tab does not count', () => {
    expect(isStudying({ ...base, reading: true, visible: false })).toBe(false);
  });
  it('nothing open → not studying', () => {
    expect(isStudying(base)).toBe(false);
  });
});

describe('StudyTicker', () => {
  it('credits whole seconds from performance.now deltas, carrying the fraction', () => {
    const t = new StudyTicker(0);
    expect(t.tick(600, true)).toBe(0);
    expect(t.tick(1200, true)).toBe(1); // 1.2 s accumulated → 1, carry 0.2
    expect(t.tick(2000, true)).toBe(1); // 0.2 + 0.8 = 1.0
  });
  it('caps a single tick at 5 s so a sleeping laptop never adds hours', () => {
    const t = new StudyTicker(0);
    expect(t.tick(3 * 3600 * 1000, true)).toBe(5);
  });
  it('credits nothing while not studying and does not bank that time for later', () => {
    const t = new StudyTicker(0);
    expect(t.tick(4000, false)).toBe(0);
    expect(t.tick(5000, true)).toBe(1);
  });
  it('ignores a clock that goes backwards', () => {
    const t = new StudyTicker(5000);
    expect(t.tick(4000, true)).toBe(0);
    expect(t.tick(5000, true)).toBe(1);
  });
});

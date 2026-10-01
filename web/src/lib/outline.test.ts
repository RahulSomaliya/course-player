import { describe, expect, it } from 'vitest';
import { buildOutline, sectionMeta, sectionSteps, sectionTag, sectionTitle } from './outline';
import { course, progressWith, section } from './test-fixtures';

const c = course([
  section(1, 'Welcome, Welcome, Welcome!', [{ title: 'Intro' }]),
  section(2, 'React Fundamentals', [{ title: 'Introduction to Part 1' }, { title: 'Useful Resources for Part 1', kind: 'article' }], {
    part: { number: 1, projects: 4 },
  }),
  section(3, 'A First Look at React', [{ title: 'Why React', duration: 3600 }, { title: 'Pure JS', duration: 1800 }]),
  section(4, 'Review of Essential JavaScript for React', [{ title: 'Destructuring' }], { optional: true }),
  section(5, 'Intermediate React', [{ title: 'Introduction to Part 2' }], { part: { number: 2, projects: null } }),
  section(6, 'How React Works Behind the Scenes', [{ title: 'Fiber' }]),
]);
const s = (n: number) => c.sections[n - 1]!;
const plan = { sectionDue: { '3': '2026-10-09', '4': '2026-10-09', '6': '2026-10-16' }, skippedSections: [4] };

describe('buildOutline (Parts are a real level above sections)', () => {
  it('loose sections before Part 1, then each part with its intro and its sections nested', () => {
    const o = buildOutline(c);
    expect(o.map((n) => (n.kind === 'part' ? `part ${n.number}` : `§${n.section.id}`))).toEqual(['§01', 'part 1', 'part 2']);
    const p1 = o[1];
    expect(p1).toMatchObject({ kind: 'part', number: 1, title: 'React Fundamentals', projects: 4 });
    if (p1?.kind !== 'part') throw new Error('part expected');
    expect(p1.intro.id).toBe('02');
    expect(p1.sections.map((x) => x.id)).toEqual(['03', '04']);
    const p2 = o[2];
    if (p2?.kind !== 'part') throw new Error('part expected');
    expect(p2.projects).toBeNull();
    expect(p2.sections.map((x) => x.id)).toEqual(['06']);
  });
});

describe('sectionMeta (closed row: number · title · quiet ✓; the rest on hover/focus)', () => {
  it('length + due date from her plan', () => {
    expect(sectionMeta(s(3), {}, plan)).toEqual({ done: false, skipped: false, due: 'due Fri 9 Oct', length: '1h 30m' });
  });
  it('done → a quiet ✓ and no due date', () => {
    const p = progressWith({ [s(3).lectures[0]!.id]: { done: true }, [s(3).lectures[1]!.id]: { done: true } });
    expect(sectionMeta(s(3), p.lectures, plan)).toMatchObject({ done: true, due: null });
  });
  it('a section her plan skips (§04) is marked skipped, with no due date', () => {
    expect(sectionMeta(s(4), {}, plan)).toMatchObject({ skipped: true, due: null });
  });
  // Review 2026-10-01: §04 finished anyway showed "Skipped" AND the done ✓, dimmed — two signals that
  // contradict each other. Finished wins.
  it('a section her plan skips but she finished anyway is done, not skipped', () => {
    const p = progressWith(Object.fromEntries(s(4).lectures.map((l) => [l.id, { done: true }])));
    expect(sectionMeta(s(4), p.lectures, plan)).toMatchObject({ done: true, skipped: false, due: null });
  });
  it('no plan (not connected, nothing cached) → no due date, nothing skipped', () => {
    expect(sectionMeta(s(4), {}, null)).toMatchObject({ skipped: false, due: null });
  });
  it('an empty section is never "done"', () => {
    expect(sectionMeta(section(9, 'Empty', []), {}, null).done).toBe(false);
  });
});

describe('Watch sidebar: one section at a time', () => {
  it('names a section or a part introduction', () => {
    expect(sectionTag(s(3))).toBe('Section 03');
    expect(sectionTitle(s(3))).toBe('A First Look at React');
    expect(sectionTag(s(2))).toBe('Part 1 · Introduction');
    expect(sectionTitle(s(2))).toBe('React Fundamentals');
  });
  it('steps to the previous / next section in course order, part introductions included', () => {
    expect(sectionSteps(c, '03')).toEqual({ prev: s(2), next: s(4) });
    expect(sectionSteps(c, '01')).toEqual({ prev: null, next: s(2) });
    expect(sectionSteps(c, '06')).toEqual({ prev: s(5), next: null });
    expect(sectionSteps(c, 'nope')).toEqual({ prev: null, next: null });
  });
});

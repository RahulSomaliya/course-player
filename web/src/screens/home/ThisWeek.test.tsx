// @vitest-environment jsdom
// This week → "See full plan" (spec v3 A7): her whole plan, week by week, the break in place.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { JourneyStatus, PlanRow } from '../../../../shared/types';
import { ThisWeek } from './ThisWeek';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const plan: PlanRow[] = [
  { kind: 'week', week: 1, due: '2026-10-09', goal: '§7 Thinking In React', state: 'done' },
  { kind: 'week', week: 2, due: '2026-10-16', goal: '§8 Practice Project', state: 'current' },
  { kind: 'break', label: 'Diwali', start: '2026-10-26', end: '2026-11-08', now: false },
  { kind: 'week', week: 3, due: '2026-11-13', goal: '§9 How React Works', state: 'upcoming' },
];
const status: JourneyStatus = {
  pace: 'on-track',
  daysDelta: 0,
  week: 2,
  totalWeeks: 10,
  targetDate: '2026-12-25',
  deadline: '2027-01-01',
  goal: { sectionNumber: 8, title: 'Practice Project', due: '2026-10-16' },
  coachNote: null,
  planBreak: null,
  sectionDue: {},
  skippedSections: [],
  studyWeekdays: [1, 2, 3, 4, 5],
  planBreaks: [],
  plan,
};

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function mount(s: JourneyStatus): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(ThisWeek, { status: s })));
  return host;
}
const toggle = (host: HTMLElement): HTMLButtonElement | null => host.querySelector('[data-control="full-plan"]');

describe('This week → See full plan', () => {
  it('closed at first; opening lists every week and the break, in order, with its state in words', () => {
    const host = mount(status);
    expect(toggle(host)?.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('[data-plan]')).toBeNull();
    act(() => toggle(host)?.click());
    expect(toggle(host)?.getAttribute('aria-expanded')).toBe('true');
    expect(toggle(host)?.textContent).toContain('Hide full plan');
    const rows = [...host.querySelectorAll('[data-plan] > li')].map((li) => li.textContent);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain('Week 1');
    expect(rows[0]).toContain('done');
    expect(rows[1]).toContain('This week');
    expect(rows[1]).toContain('Fri 16 Oct');
    expect(rows[2]).toContain('Diwali break');
    expect(rows[2]).toContain('26 Oct – 8 Nov');
    expect(rows[3]).toContain('§9 How React Works');
  });

  it('no plan (an older JS Journey, or a status cached before it) → no toggle', () => {
    const { plan: _plan, ...older } = status;
    expect(toggle(mount(older))).toBeNull();
    act(() => root?.unmount());
    root = null;
    expect(toggle(mount({ ...status, plan: [] }))).toBeNull();
  });
});

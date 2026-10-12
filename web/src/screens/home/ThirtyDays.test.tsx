// @vitest-environment jsdom
// The 30-day chart, v4 (spec "Chart + daily goal"): the average starts when she started; goal-met days are
// the accent with a small ✓ above; every other day — today included — is chart-bar; nothing marks a short day.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { JourneyStatus } from '../../../../shared/types';
import { ThirtyDays } from './ThirtyDays';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const H = 3600;
const status: JourneyStatus = {
  pace: 'ahead',
  daysDelta: 2,
  week: 2,
  totalWeeks: 10,
  targetDate: '2026-12-25',
  deadline: '2027-01-01',
  goal: null,
  coachNote: null,
  planBreak: null,
  sectionDue: {},
  skippedSections: [4],
  studyWeekdays: [1, 2, 3, 4, 5],
  planBreaks: [],
  startDate: '2026-10-05',
  dailyGoalMinutes: 150,
};
// Week 1 (Mon 5 – Fri 9 Oct) + Mon 12 Oct (today): 2.5 h (met), 2 h, 3 h (met), 1 h, 2.5 h (met); today 40 m
const DAYS = { '2026-10-05': 2.5 * H, '2026-10-06': 2 * H, '2026-10-07': 3 * H, '2026-10-08': H, '2026-10-09': 2.5 * H, '2026-10-12': 40 * 60 };
const TODAY = '2026-10-12';

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function mount(props: { status?: JourneyStatus | null; days?: Record<string, number>; moment?: boolean; intro?: boolean }): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      createElement(ThirtyDays, {
        status: props.status === undefined ? status : props.status,
        days: props.days ?? DAYS,
        today: TODAY,
        intro: props.intro ?? false,
        moment: props.moment ?? false,
      }),
    ),
  );
  return host;
}
const column = (host: HTMLElement, day: string): HTMLElement | null => host.querySelector(`[data-day="${day}"]`);
const bar = (host: HTMLElement, day: string): string => column(host, day)?.querySelector('[data-bar]')?.getAttribute('class') ?? '';
const check = (host: HTMLElement, day: string): Element | null => column(host, day)?.querySelector('[data-goal-check]') ?? null;

describe('Last 30 days (v4)', () => {
  it('goal-met days are the accent with a small ✓ above; every other day is chart-bar, no mark', () => {
    const host = mount({});
    for (const met of ['2026-10-05', '2026-10-07', '2026-10-09']) {
      expect(bar(host, met), met).toMatch(/\bbg-accent\b/);
      expect(check(host, met), met).not.toBeNull();
    }
    for (const short of ['2026-10-06', '2026-10-08']) {
      expect(bar(host, short), short).toMatch(/\bbg-chart-bar\b/);
      expect(check(host, short), short).toBeNull();
    }
    expect(host.querySelectorAll('[data-goal-check]')).toHaveLength(3);
  });

  it('today not met yet is chart-bar too (no "x min left", nothing marks it) — and keeps its "Today" label', () => {
    const host = mount({});
    expect(bar(host, TODAY)).toMatch(/\bbg-chart-bar\b/);
    expect(check(host, TODAY)).toBeNull();
    expect(host.textContent).toContain('Today');
  });

  it('today met → accent + ✓', () => {
    const host = mount({ days: { ...DAYS, [TODAY]: 150 * 60 } });
    expect(bar(host, TODAY)).toMatch(/\bbg-accent\b/);
    expect(check(host, TODAY)).not.toBeNull();
  });

  it('the average starts when she started: avg over the plan study days, not all 30', () => {
    // (2.5 + 2 + 3 + 1 + 2.5) h ÷ 5 study days (today, 40 m, counts too: ≥ 5 min) = 11 h + 40 m over 6 days
    expect(mount({}).textContent).toContain('avg 1h 56m');
  });

  it('no dailyGoalMinutes (an older JS Journey / not connected): no goal visuals at all — today in the accent, as before', () => {
    const { dailyGoalMinutes: _goal, ...older } = status;
    const host = mount({ status: older });
    expect(host.querySelectorAll('[data-goal-check]')).toHaveLength(0);
    expect(bar(host, '2026-10-07')).toMatch(/\bbg-chart-bar\b/);
    expect(bar(host, TODAY)).toMatch(/\bbg-accent\b/);
    act(() => root?.unmount());
    root = null;
    expect(mount({ status: null }).querySelectorAll('[data-goal-check]')).toHaveLength(0);
  });

  it('the moment: today\'s bar rises once and its ✓ draws in; other met days stay still', () => {
    const met = { ...DAYS, [TODAY]: 151 * 60 };
    const host = mount({ days: met, moment: true });
    expect(bar(host, TODAY)).toContain('animate-goal-rise');
    expect(check(host, TODAY)?.querySelector('path')?.getAttribute('class')).toContain('animate-draw');
    expect(bar(host, '2026-10-07')).not.toContain('animate-goal-rise');
    expect(check(host, '2026-10-07')?.querySelector('path')?.getAttribute('class')).not.toContain('animate-draw');
    act(() => root?.unmount());
    root = null;
    const still = mount({ days: met, moment: false });
    expect(bar(still, TODAY)).not.toContain('animate-goal-rise');
    expect(check(still, TODAY)?.querySelector('path')?.getAttribute('class')).not.toContain('animate-draw');
  });

  it('a screen reader hears which days met the goal (the ✓ is aria-hidden)', () => {
    const rows = [...mount({}).querySelectorAll('table tr')].map((r) => r.textContent ?? '');
    expect(rows.find((r) => r.startsWith('Wed 7 Oct'))).toBe('Wed 7 Oct3h · daily goal met');
    expect(rows.find((r) => r.startsWith('Tue 6 Oct'))).toBe('Tue 6 Oct2h');
  });
});

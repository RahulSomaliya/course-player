import { describe, expect, it } from 'vitest';
import type { PlanRow } from '../../../shared/types';
import { planView } from './plan';

const rows: PlanRow[] = [
  { kind: 'week', week: 1, due: '2026-10-09', goal: '§7 Thinking In React', state: 'done' },
  { kind: 'week', week: 2, due: '2026-10-16', goal: '§8 Practice Project', state: 'behind' },
  { kind: 'week', week: 3, due: '2026-10-23', goal: '§9 How React Works', state: 'current' },
  { kind: 'break', label: 'Diwali', start: '2026-10-26', end: '2026-11-08', now: false },
  { kind: 'week', week: 4, due: '2026-11-13', goal: '§10 Effects', state: 'upcoming' },
  { kind: 'week', week: 5, due: '2026-11-20', goal: 'Keep going: §11 Custom Hooks', state: 'past' },
];

describe('planView: her plan week by week (Home → This week → See full plan, spec v3 A7)', () => {
  it('each week: its goal and Friday, and its state as a mark AND a word (never colour alone)', () => {
    const view = planView(rows, [1, 2, 3, 4, 5]);
    expect(view[0]).toEqual({ kind: 'week', key: 'w1', title: 'Week 1', goal: '§7 Thinking In React', due: 'Fri 9 Oct', mark: 'done', tag: null, srState: 'done', quiet: false });
    expect(view[1]).toMatchObject({ mark: 'open', tag: 'Behind', srState: 'behind', quiet: false });
    expect(view[2]).toMatchObject({ mark: 'current', tag: 'This week', srState: 'this week', quiet: false });
    expect(view[4]).toMatchObject({ mark: 'open', tag: null, srState: 'upcoming', quiet: true });
    expect(view[5]).toMatchObject({ goal: 'Keep going: §11 Custom Hooks', mark: 'open', tag: null, srState: 'keep going', quiet: true });
  });

  it('the break sits in place: its dates and how many study days it takes off', () => {
    expect(planView(rows, [1, 2, 3, 4, 5])[3]).toEqual({
      kind: 'break',
      key: 'b2026-10-26',
      title: 'Diwali break',
      tag: null,
      dates: '26 Oct – 8 Nov',
      detail: '10 study days off — every date here already skips them.',
    });
    const now = planView([{ kind: 'break', label: 'Diwali', start: '2026-10-26', end: '2026-10-26', now: true }], [1, 2, 3, 4, 5]);
    expect(now[0]).toMatchObject({ tag: 'Now', detail: '1 study day off — every date here already skips it.' });
  });
});

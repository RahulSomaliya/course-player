// @vitest-environment jsdom
// The Today stat, v4 (spec "Chart + daily goal"): met → the number + a small accent ✓ and "Daily goal met";
// not met → the number alone. The once-a-day moment draws the ✓ in.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { AppContext, type AppValue } from '../../app/context';
import { indexCourse } from '../../lib/course';
import { sampleCourse } from '../../lib/test-fixtures';
import { ProgressContext, ProgressStore } from '../../state/progress';
import { Stats } from './Stats';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const course = sampleCourse();
const TODAY = '2026-10-12';

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function mount(props: { seconds: number; met: boolean; moment?: boolean }): HTMLElement {
  const app: AppValue = {
    course,
    index: indexCourse(course),
    profile: { id: 'mansi', name: 'Mansi', journeyConnected: true },
    openSignOff: () => undefined,
    openNote: () => undefined,
    quit: () => undefined,
    updateProfile: () => undefined,
  };
  const progress = new ProgressStore({ courseId: course.id, profile: 'mansi', storage: null, api: { get: async () => null, put: async () => undefined } });
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      createElement(
        AppContext.Provider,
        { value: app },
        createElement(
          ProgressContext.Provider,
          { value: progress },
          createElement(Stats, { status: null, intro: false, days: { [TODAY]: props.seconds }, today: TODAY, met: props.met, moment: props.moment ?? false }),
        ),
      ),
    ),
  );
  return host;
}
const today = (host: HTMLElement): HTMLElement | null => host.querySelector('[data-stat="today"]');

describe('Today stat (v4 daily goal)', () => {
  it('met → the number, a small accent ✓ and "Daily goal met" in accent-ink', () => {
    const host = mount({ seconds: 2.5 * 3600 + 120, met: true });
    expect(today(host)?.textContent).toContain('2h 32m');
    const hint = today(host)?.querySelector('[data-goal-met]');
    expect(hint?.textContent).toBe('Daily goal met');
    expect(hint?.getAttribute('class')).toContain('text-accent-ink');
    expect(hint?.querySelector('[data-goal-check]')).not.toBeNull();
  });

  it('not met → the number alone (no "x min left", no mark)', () => {
    const host = mount({ seconds: 40 * 60, met: false });
    expect(today(host)?.textContent).toBe('Today40m');
    expect(host.querySelector('[data-goal-check]')).toBeNull();
  });

  it('the moment draws the ✓ in; any later mount shows it still', () => {
    const drawn = mount({ seconds: 151 * 60, met: true, moment: true });
    expect(drawn.querySelector('[data-goal-check] path')?.getAttribute('class')).toContain('animate-draw');
    act(() => root?.unmount());
    root = null;
    const still = mount({ seconds: 151 * 60, met: true, moment: false });
    expect(still.querySelector('[data-goal-check] path')?.getAttribute('class')).not.toContain('animate-draw');
  });
});

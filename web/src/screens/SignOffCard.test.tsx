// @vitest-environment jsdom
// The sign-off card against a real StudyController (jsdom). The send is deferred by hand: the local POST
// can take a moment, and everything the card does while it is in flight is where its bugs lived.
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JourneySession, ProgressSnapshot } from '../../../shared/types';
import { AppContext, type AppValue } from '../app/context';
import { indexCourse } from '../lib/course';
import type { LiveSession, SignOffTarget } from '../lib/session';
import type { KeyValueStore } from '../lib/storage';
import { sampleCourse } from '../lib/test-fixtures';
import { ProgressStore } from '../state/progress';
import { StudyContext, StudyController, sessionKey } from '../state/study';
import { SignOffCard, type SignOffOutcome } from './SignOffCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const course = sampleCourse();
const index = indexCourse(course);
const SNAP: ProgressSnapshot = {
  course: course.id,
  takenAt: 0,
  lecturesDone: 0,
  lecturesTotal: 7,
  videoSecondsDone: 0,
  videoSecondsTotal: 4260,
  sectionsDone: [],
  current: null,
  days: {},
};
const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function liveSession(): LiveSession {
  const now = Date.now();
  return {
    id: 'live-1',
    startedAt: now - 42 * 60_000,
    lastStudyAt: now - 1000,
    seconds: 42 * 60,
    sectionSeconds: { 3: 42 * 60 },
    lecturesCompleted: [],
    finishedSections: [],
  };
}

/** A card on a 42-min live session whose send resolves only when the test says so. */
function mount(opts: { quitting?: boolean; targets?: (study: StudyController) => SignOffTarget[] } = {}) {
  const data = new Map([[sessionKey(course.id, 'mansi'), JSON.stringify(liveSession())]]);
  const storage: KeyValueStore = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
  const sent: JourneySession[] = [];
  let release: () => void = () => undefined;
  // the local POST may be slow (the course server's disk, or an older server that waited for JS Journey)
  const send = (s: JourneySession): Promise<void> =>
    new Promise<void>((r) => {
      sent.push(s);
      release = r;
    });
  const progress = new ProgressStore({ courseId: course.id, profile: 'mansi', storage, api: { get: async () => null, put: async () => undefined } });
  const study = new StudyController({ courseId: course.id, profile: 'mansi', progress, index, storage, isConnected: () => true, send, snapshot: () => SNAP });
  study.resume();
  const app: AppValue = {
    course,
    index,
    profile: { id: 'mansi', name: 'Mansi', journeyConnected: true },
    openSignOff: () => undefined,
    quit: () => undefined,
    updateProfile: () => undefined,
  };
  const outcomes: SignOffOutcome[] = [];
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const tree = (children: ReactNode) => createElement(AppContext.Provider, { value: app }, createElement(StudyContext.Provider, { value: study }, children));
  // Like App.tsx cardDone: record the outcome and unmount the card.
  const onDone = vi.fn((o: SignOffOutcome) => {
    outcomes.push(o);
    root?.render(tree(null));
  });
  const targets = opts.targets?.(study) ?? study.queue();
  act(() => root?.render(tree(createElement(SignOffCard, { targets, quitting: opts.quitting ?? false, onDone }))));
  return { study, sent, outcomes, release: () => release(), unmount: () => act(() => root?.render(tree(null))) };
}

function button(label: string): HTMLButtonElement {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.includes(label) || x.getAttribute('aria-label') === label);
  if (!b) throw new Error(`no button "${label}"`);
  return b;
}
const primary = (): HTMLButtonElement => {
  const b = document.querySelector<HTMLButtonElement>('[data-control="signoff-primary"]');
  if (!b) throw new Error('no primary button');
  return b;
};

describe('SignOffCard: closing while Send is in flight', () => {
  // Review 2026-10-01: ×/Escape/scrim stayed live while sending. The card unmounted on close(false),
  // then the slow send resolved and its leftover timer fired onDone({completed: true}) a second time —
  // App's stale cardDone still had quitting: true and stopped the server she chose to keep studying on.
  it('×, Escape and the scrim do nothing until the send settles; onDone fires exactly once', async () => {
    const card = mount({ quitting: true });
    act(() => button('Sign off & quit').click()); // Send is now in flight
    expect(button('Not now — keep studying').disabled).toBe(true);
    act(() => button('Not now — keep studying').click());
    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    act(() => document.querySelector<HTMLElement>('[data-dialog] > [aria-hidden="true"]')?.click());
    await wait(250);
    expect(card.outcomes).toEqual([]);

    await act(async () => card.release()); // the slow POST lands
    await wait(1000); // SENT_HOLD_MS 650 + LEAVE_MS 180
    expect(card.outcomes).toEqual([{ sent: 1, completed: true }]);
  });

  it('a card unmounted while its send is in flight never reports afterwards', async () => {
    const card = mount({ quitting: true });
    act(() => button('Sign off & quit').click());
    card.unmount();
    await act(async () => card.release());
    await wait(1000);
    expect(card.outcomes).toEqual([]);
  });
});

describe('SignOffCard: the success moment', () => {
  // Review 2026-10-01: after the "Sent ✓" hold the button fell back to a 50 %-faded, disabled "Send to
  // Rahul" while the card left — as if the send was undone.
  it('"Sent ✓" stays through the exit, at full colour (aria-disabled, never the disabled look)', async () => {
    const card = mount();
    act(() => primary().click());
    expect(primary().disabled).toBe(false);
    expect(primary().getAttribute('aria-disabled')).toBe('true');
    await act(async () => card.release());
    expect(primary().textContent).toContain('Sent');
    await wait(700); // past the 650 ms hold: the card is leaving
    expect(document.querySelector('[data-dialog]')).not.toBeNull();
    expect(primary().textContent).toContain('Sent');
    expect(primary().disabled).toBe(false);
    expect(primary().getAttribute('aria-disabled')).toBe('true');
  });
});

describe('SignOffCard: a session that already went to Rahul', () => {
  it('says so and waits for her (no silent advance); her note stays in the field', async () => {
    const gone: LiveSession = { ...liveSession(), id: 'gone-1' }; // not in the controller any more
    const card = mount({ targets: (study) => [{ kind: 'pending', session: gone }, ...study.queue()] });
    const field = document.querySelector('textarea');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(field, 'useEffect cleanup confused me');
      field?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => primary().click());
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/already went to Rahul/);
    expect(document.querySelector('textarea')?.value).toBe('useEffect cleanup confused me');
    expect(card.sent).toEqual([]);
    expect(primary().textContent).toBe('Next');
    act(() => primary().click());
    expect(document.querySelector('[data-signoff]')?.getAttribute('data-signoff')).toBe('live');
  });
});

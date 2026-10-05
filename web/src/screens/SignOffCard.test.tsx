// @vitest-environment jsdom
// The sign-off card against a real StudyController + JourneyStore (jsdom). The POST and the delivery
// answer are deferred by hand: everything the card does while they are in flight is where its bugs lived.
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JourneySession, OutboxState, OutboxUpdate, ProgressSnapshot } from '../../../shared/types';
import { AppContext, type AppValue } from '../app/context';
import { indexCourse } from '../lib/course';
import { newSession } from '../lib/session';
import type { KeyValueStore } from '../lib/storage';
import { sampleCourse } from '../lib/test-fixtures';
import { JourneyContext, JourneyStore } from '../state/journey';
import { ProgressStore } from '../state/progress';
import { SESSION_ENDED_ELSEWHERE, StudyContext, StudyController, studyKey } from '../state/study';
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
  current: { sectionNumber: 3, lectureNumber: 1, title: 'Props' },
  days: {},
};
const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

type Answer = { state: 'delivered' } | { state: 'queued' } | { state: 'rejected'; error: string };
const outboxWith = (id: string, a: Answer, session: JourneySession): OutboxState => {
  const u: OutboxUpdate =
    a.state === 'delivered'
      ? { id, state: 'delivered', at: '2026-10-05T10:00:00Z', error: null }
      : a.state === 'queued'
        ? { id, state: 'queued', at: session.endedAt, error: null, session }
        : { id, state: 'rejected', at: '2026-10-05T10:00:00Z', error: a.error, session };
  return { pending: a.state === 'queued' ? 1 : 0, lastError: null, updates: [u] };
};

const KEY = studyKey(course.id, 'mansi');

/**
 * A card on a session started 83 min ago (or `startedAgoMs`; or none). `post` = what the course server
 * does with the POST (resolve = 202 at once by default); `delivery` = what GET outbox?wait= answers.
 */
function mount(
  opts: { mode?: 'session' | 'note'; quitting?: boolean; running?: boolean; startedAgoMs?: number; connected?: boolean; post?: 'ok' | 'hold' | 'fail'; delivery?: Answer | 'hold' } = {},
) {
  const data = new Map<string, string>();
  if (opts.running ?? true) data.set(KEY, JSON.stringify(newSession('live-1', Date.now() - (opts.startedAgoMs ?? 83 * 60_000 + 5_000), false)));
  const storage: KeyValueStore = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
  const sent: JourneySession[] = [];
  let releasePost: () => void = () => undefined;
  let releaseDelivery: (a: Answer) => void = () => undefined;
  const send = (s: JourneySession): Promise<void> => {
    sent.push(s);
    if (opts.post === 'fail') return Promise.reject(new Error('server down'));
    if (opts.post === 'hold') return new Promise<void>((r) => (releasePost = r));
    return Promise.resolve();
  };
  const outbox = (): Promise<OutboxState> => {
    const last = sent.at(-1);
    if (!last) return Promise.resolve({ pending: 0, lastError: null, updates: [] });
    if (opts.delivery === 'hold') return new Promise((r) => (releaseDelivery = (a) => r(outboxWith(last.id, a, last))));
    return Promise.resolve(outboxWith(last.id, opts.delivery ?? { state: 'delivered' }, last));
  };
  const progress = new ProgressStore({ courseId: course.id, profile: 'mansi', storage, api: { get: async () => null, put: async () => undefined } });
  const study = new StudyController({ courseId: course.id, legacyCourseId: course.id, profile: 'mansi', progress, index, storage, send, snapshot: () => SNAP });
  study.resume();
  const journey = new JourneyStore({
    courseId: course.id,
    profile: 'mansi',
    storage,
    isConnected: () => opts.connected ?? true,
    api: { status: async () => null, feed: async () => null, read: async () => undefined, outbox, retry: outbox },
  });
  const app: AppValue = {
    course,
    index,
    profile: { id: 'mansi', name: 'Mansi', journeyConnected: opts.connected ?? true },
    openSignOff: () => undefined,
    openNote: () => undefined,
    quit: () => undefined,
    updateProfile: () => undefined,
  };
  const outcomes: SignOffOutcome[] = [];
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const tree = (children: ReactNode) =>
    createElement(
      AppContext.Provider,
      { value: app },
      createElement(JourneyContext.Provider, { value: journey }, createElement(StudyContext.Provider, { value: study }, children)),
    );
  // Like App.tsx cardDone: record the outcome and unmount the card.
  const onDone = vi.fn((o: SignOffOutcome) => {
    outcomes.push(o);
    root?.render(tree(null));
  });
  act(() => root?.render(tree(createElement(SignOffCard, { mode: opts.mode ?? 'session', quitting: opts.quitting ?? false, onDone }))));
  return {
    study,
    progress,
    /** the browser's localStorage, shared with "another window" of the app */
    data,
    sent,
    outcomes,
    releasePost: () => releasePost(),
    releaseDelivery: (a: Answer) => releaseDelivery(a),
    unmount: () => act(() => root?.render(tree(null))),
  };
}

function button(label: string): HTMLButtonElement {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === label || x.getAttribute('aria-label') === label);
  if (!b) throw new Error(`no button "${label}"`);
  return b;
}
const primary = (): HTMLButtonElement => {
  const b = document.querySelector<HTMLButtonElement>('[data-control="signoff-primary"]');
  if (!b) throw new Error('no primary button');
  return b;
};
const field = (label: string): HTMLInputElement => {
  const f = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!f) throw new Error(`no field "${label}"`);
  return f;
};
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  act(() => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const note = (): HTMLTextAreaElement => {
  const t = document.querySelector('textarea');
  if (!t) throw new Error('no note field');
  return t;
};
const text = (sel: string): string => document.querySelector(sel)?.textContent ?? '';

describe('SignOffCard: what she sees before Send (spec v3 A5)', () => {
  it('"Timer: 1h 23m · started …" and Time studied prefilled from the timer, rounded down', () => {
    mount();
    expect(text('[data-signoff="timer"]')).toMatch(/^Timer: 1h 23m · started \d{1,2}:\d{2}$/);
    expect(field('Hours').value).toBe('1');
    expect(field('Minutes').value).toBe('23');
    expect(primary().textContent).toBe('Send to Rahul');
    expect(primary().disabled).toBe(false);
  });

  it('never above the timer: an inline reason, and Send waits', () => {
    mount();
    type(field('Minutes'), '30');
    expect(document.body.textContent).toContain('That’s more than the timer (1h 23m).');
    expect(primary().disabled).toBe(true);
    type(field('Minutes'), '10');
    expect(primary().disabled).toBe(false);
  });

  it('nothing to send (0 min, no note): Send is disabled WITH the reason; a note enables it', () => {
    mount();
    type(field('Hours'), '0');
    type(field('Minutes'), '0');
    expect(primary().disabled).toBe(true);
    expect(text('[data-signoff="reason"]')).toBe('Add the time you studied, or a note.');
    type(note(), 'read about keys');
    expect(primary().disabled).toBe(false);
  });

  // Review 2026-10-05: v3 has no 24 h auto-close, so a timer left running over a weekend is normal. The
  // card prefilled "24h 0m" and one tap sent and credited a whole day she never studied.
  it('a forgotten timer (over 24 h) prefills nothing: Send waits until she sets her real time', async () => {
    const card = mount({ startedAgoMs: 63 * 3_600_000 });
    expect([field('Hours').value, field('Minutes').value]).toEqual(['', '']);
    expect(primary().disabled).toBe(true);
    expect(text('[data-signoff="reason"]')).toBe('The timer ran longer than a day — set the real time.');
    type(note(), 'a weekend away');
    expect(primary().disabled).toBe(true); // a note does not answer the question: how long?
    type(field('Hours'), '1');
    expect(primary().disabled).toBe(false);
    await act(async () => primary().click());
    expect(card.sent[0]).toMatchObject({ id: 'live-1', minutes: 60, note: 'a weekend away' });
  });

  it('Note to Rahul…: no timer, no time fields; the note is required', () => {
    mount({ mode: 'note', running: false });
    expect(document.querySelector('[data-signoff]')?.getAttribute('data-signoff')).toBe('note');
    expect(document.querySelector('input[aria-label="Hours"]')).toBeNull();
    expect(primary().disabled).toBe(true);
    expect(text('[data-signoff="reason"]')).toBe('Write a note for Rahul.');
  });
});

describe('SignOffCard: Send and the confirmation', () => {
  it('delivered → "Sent to Rahul" + what was logged; it stays until Done', async () => {
    const card = mount();
    type(note(), 'props finally clicked');
    await act(async () => primary().click());
    expect(card.sent[0]).toMatchObject({ id: 'live-1', minutes: 83, note: 'props finally clicked' });
    expect(document.querySelector('[data-signoff-result]')?.getAttribute('data-signoff-result')).toBe('delivered');
    expect(document.body.textContent).toContain('Sent to Rahul');
    expect(document.body.textContent).toContain('1h 23m logged · note included');
    await wait(1500); // never a sub-second flash
    expect(document.querySelector('[data-signoff-result]')).not.toBeNull();
    expect(card.outcomes).toEqual([]);
    act(() => button('Done').click());
    await wait(250);
    expect(card.outcomes).toEqual([{ sent: 1, quit: false }]);
  });

  it('the timer stops the moment the outbox has it — before the delivery answer', async () => {
    const card = mount({ delivery: 'hold' });
    await act(async () => primary().click());
    expect(card.study.getState().session).toBeNull();
    expect(primary().textContent).toBe('Sending…');
    expect(primary().getAttribute('aria-disabled')).toBe('true');
    expect(primary().disabled).toBe(false); // busy is never the faded "undone" look
    await act(async () => card.releaseDelivery({ state: 'queued' }));
    expect(document.querySelector('[data-signoff-result]')?.getAttribute('data-signoff-result')).toBe('saved');
    expect(document.body.textContent).toContain('It will reach Rahul as soon as you’re online.');
  });

  it('not connected: "Saved" says it goes once JS Journey is connected', async () => {
    mount({ connected: false, delivery: { state: 'queued' } });
    await act(async () => primary().click());
    expect(document.body.textContent).toContain('once JS Journey is connected');
  });

  it('the minutes she sends are credited to her study days', async () => {
    const card = mount();
    await card.progress.hydrate();
    type(field('Minutes'), '0');
    await act(async () => primary().click());
    const total = Object.values(card.progress.get().days).reduce((a, b) => a + b, 0);
    expect(total).toBe(60 * 60);
  });

  // 2026-10-05: JS Journey refused her update and nobody knew. Refused = back on the form, her words kept.
  it('rejected → stays on the form with the reason; Try again re-sends the SAME update with her edits', async () => {
    const card = mount({ delivery: { state: 'rejected', error: 'HTTP 404 — unknown course' } });
    type(note(), 'first words');
    await act(async () => primary().click());
    expect(text('[data-signoff="error"]')).toBe('Didn’t reach Rahul — unknown course (HTTP 404)');
    expect(note().value).toBe('first words');
    expect(primary().textContent).toBe('Try again');
    expect(field('Hours').disabled).toBe(true); // its time was logged at the first Send
    type(note(), 'second words');
    await act(async () => primary().click());
    expect(card.sent.map((s) => [s.id, s.note, s.minutes])).toEqual([
      ['live-1', 'first words', 83],
      ['live-1', 'second words', 83],
    ]);
  });

  it('the course server did not take it: the timer keeps running and she can send again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const card = mount({ post: 'fail' });
    await act(async () => primary().click());
    expect(text('[data-signoff="error"]')).toBe('Couldn’t hand it to the course app — is it still running? Try again.');
    expect(card.study.getState().session?.id).toBe('live-1');
    expect(primary().textContent).toBe('Send to Rahul');
  });

  it('Send & quit (from Quit) → the confirmation\'s button quits', async () => {
    const card = mount({ quitting: true });
    expect(primary().textContent).toBe('Send & quit');
    await act(async () => primary().click());
    act(() => button('Quit').click());
    await wait(250);
    expect(card.outcomes).toEqual([{ sent: 1, quit: true }]);
  });
});

describe('SignOffCard: not now, discard, quit', () => {
  it('× = not now: the timer keeps running, nothing sent', async () => {
    const card = mount();
    act(() => button('Not now').click());
    await wait(250);
    expect(card.outcomes).toEqual([{ sent: 0, quit: false }]);
    expect(card.study.getState().session?.id).toBe('live-1');
    expect(card.sent).toEqual([]);
  });

  it('Discard is confirmed in place ("Discard 1h 23m? · Yes, discard"), sends nothing, credits nothing', async () => {
    const card = mount();
    act(() => button('Discard').click());
    expect(document.body.textContent).toContain('Discard 1h 23m?');
    act(() => button('Keep').click());
    expect(card.study.getState().session).not.toBeNull();
    act(() => button('Discard').click());
    act(() => button('Yes, discard').click());
    await wait(250);
    expect(card.study.getState().session).toBeNull();
    expect(card.sent).toEqual([]);
    expect(card.outcomes).toEqual([{ sent: 0, quit: false }]);
  });

  it('Quit, keep timer: quits without sending — the timer survives the restart', async () => {
    const card = mount({ quitting: true });
    act(() => button('Quit, keep timer').click());
    await wait(250);
    expect(card.outcomes).toEqual([{ sent: 0, quit: true }]);
    expect(card.study.getState().session?.id).toBe('live-1');
  });

  // Review 2026-10-01: ×/Escape/scrim stayed live while sending; the card unmounted, then the slow send
  // resolved and a leftover timer reported a SECOND outcome — App quit after "keep studying".
  it('while the hand-over is in flight ×, Escape and the scrim do nothing; onDone fires exactly once', async () => {
    const card = mount({ quitting: true, post: 'hold' });
    act(() => primary().click());
    expect(button('Not now — keep studying').disabled).toBe(true);
    act(() => button('Not now — keep studying').click());
    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    act(() => document.querySelector<HTMLElement>('[data-dialog] > [aria-hidden="true"]')?.click());
    await wait(250);
    expect(card.outcomes).toEqual([]);
    await act(async () => card.releasePost());
    act(() => button('Quit').click());
    act(() => button('Quit').click());
    await wait(250);
    expect(card.outcomes).toEqual([{ sent: 1, quit: true }]);
  });

  it('once the outbox has it, closing during the delivery wait is safe and reports it as sent', async () => {
    const card = mount({ delivery: 'hold' });
    await act(async () => primary().click());
    act(() => button('Not now').click());
    await wait(250);
    expect(card.outcomes).toEqual([{ sent: 1, quit: false }]);
    await act(async () => card.releaseDelivery({ state: 'delivered' })); // late: nothing more happens
    await wait(50);
    expect(card.outcomes).toHaveLength(1);
  });

  it('a card unmounted while its hand-over is in flight never reports afterwards', async () => {
    const card = mount({ post: 'hold' });
    act(() => primary().click());
    card.unmount();
    await act(async () => card.releasePost());
    await wait(300);
    expect(card.outcomes).toEqual([]);
  });
});

// Review 2026-10-05: a 2nd window of the app sent the session; this one still showed it, and Send posted
// the same id again — JS Journey ignored it as a duplicate while this card said "Sent ✓ · note included".
describe('SignOffCard: the session ended in another window', () => {
  it('while the card is open: it says so at once, and her note can still go — as a Note to Rahul', async () => {
    const card = mount();
    const stop = card.study.start();
    type(note(), 'second note');
    act(() => {
      card.data.delete(KEY); // the other window sent it
      window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: null }));
    });
    expect(text('[data-signoff="error"]')).toBe(SESSION_ENDED_ELSEWHERE);
    expect(document.querySelector('input[aria-label="Hours"]')).toBeNull();
    expect(document.querySelector('[data-control="signoff-discard"]')).toBeNull();
    expect(note().value).toBe('second note');
    await act(async () => primary().click());
    expect(card.sent).toMatchObject([{ minutes: 0, note: 'second note' }]);
    expect(card.sent[0]?.id).not.toBe('live-1');
    stop();
  });

  it('a new session started there meanwhile is not this card\'s: it never sends that one either', async () => {
    const card = mount();
    type(note(), 'second note');
    act(() => card.data.set(KEY, JSON.stringify(newSession('other-2', Date.now(), false))));
    await act(async () => primary().click()); // no storage event yet: Send itself re-reads the key
    expect(card.sent).toEqual([]);
    expect(text('[data-signoff="error"]')).toBe(SESSION_ENDED_ELSEWHERE);
    expect(note().value).toBe('second note');
    expect(card.study.getState().session?.id).toBe('other-2');
  });
});

// Review 2026-10-05: the Dialog put focus back on the element focused when it opened — after Send or
// Discard that is the timer chip, which the header has swapped for "Start studying" (and the menu item
// behind "Note to Rahul…" is gone with its menu): focus fell to <body> and Tab restarted at the page top.
describe('SignOffCard: where keyboard focus goes when it closes', () => {
  const headerButton = (control: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.dataset.control = control;
    document.body.append(b);
    return b;
  };

  it('after Send the chip is gone: Start studying (the header timer slot), never <body>', async () => {
    const chip = headerButton('sign-off');
    chip.focus();
    mount();
    await act(async () => primary().click());
    chip.remove(); // the header swapped the chip for Start studying when the timer stopped
    const start = headerButton('start-studying');
    act(() => button('Done').click());
    await wait(250);
    expect(document.activeElement).toBe(start);
  });

  it('a note card opened from the menu (its item gone with the menu): back to the menu button', async () => {
    const menu = headerButton('settings-menu');
    mount({ mode: 'note', running: false });
    act(() => button('Not now').click());
    await wait(250);
    expect(document.activeElement).toBe(menu);
  });

  it('the element focused at open still there (× = not now): focus goes back to it', async () => {
    const quit = headerButton('quit');
    quit.focus();
    mount({ quitting: true });
    act(() => button('Not now — keep studying').click());
    await wait(250);
    expect(document.activeElement).toBe(quit);
  });
});

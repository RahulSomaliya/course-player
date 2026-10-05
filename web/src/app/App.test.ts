// @vitest-environment jsdom
// <App/> end to end (fetch stubbed): boot → ProfileApp → the SSD progress copy.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BootPayload, JourneySession, ProgressState } from '../../../shared/types';
import { emptyProgress } from '../lib/progress';
import { newSession } from '../lib/session';
import { sampleCourse } from '../lib/test-fixtures';
import { progressKey } from '../state/progress';
import { studyKey } from '../state/study';
import { App } from './App';

// React 19 act() environment flag; jsdom has no type for it on globalThis.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const course = sampleCourse();
const ids = course.sections.flatMap((s) => s.lectures.map((l) => l.id));
const SSD_SAVED_AT = Date.now() - 86_400_000; // written yesterday on the other Mac

const ssdCopy: ProgressState = {
  ...emptyProgress(SSD_SAVED_AT),
  lastLectureId: ids[1] as string,
  lectures: {
    [ids[0] as string]: { pos: 590, done: true, doneAt: SSD_SAVED_AT - 3_600_000 },
    [ids[1] as string]: { pos: 300, done: false, doneAt: null },
  },
  days: { '2026-09-30': 5400 },
};

let boot: BootPayload = { course, profiles: [{ id: 'mansi', name: 'Mansi', journeyConnected: false }], version: 'test', courseIdFrom: 'course.json', folderCourseId: course.id };
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** Stubs the course server; GET /api/progress/mansi answers when `progress` resolves. `calls` = every
 *  other request ("METHOD url"), `sessions` = the updates POSTed for Rahul. */
function stubServer(progress: Promise<ProgressState>): { puts: ProgressState[]; calls: string[]; sessions: JourneySession[] } {
  const puts: ProgressState[] = [];
  const calls: string[] = [];
  const sessions: JourneySession[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/api/boot') return json(boot);
      if (url === '/api/progress/mansi' && method === 'GET') return json(await progress);
      if (url === '/api/progress/mansi' && method === 'PUT') {
        puts.push(JSON.parse(String(init?.body)) as ProgressState);
        return json(puts.at(-1));
      }
      calls.push(`${method} ${url}`);
      if (url === '/api/journey/mansi/sessions') {
        const session = JSON.parse(String(init?.body)) as JourneySession;
        sessions.push(session);
        return json({ pending: 1, lastError: null, updates: [{ id: session.id, state: 'queued', at: session.endedAt, error: null, session }] });
      }
      if (url.startsWith('/api/journey/mansi/outbox')) return json({ pending: 0, lastError: null, updates: [] });
      if (url === '/api/profiles/mansi/journey' && method === 'PUT') return json({ id: 'mansi', name: 'Mansi', journeyConnected: true });
      return new Response(null, { status: 204 });
    }),
  );
  return { puts, calls, sessions };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
let root: Root | null = null;

/** Renders <App/> inside act() and lets `ms` of fetches/effects settle. */
async function mount(ms: number): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.append(host);
  const r = createRoot(host);
  root = r;
  await act(async () => {
    r.render(createElement(App));
    await tick(ms);
  });
  return host;
}

afterEach(() => {
  boot = { course, profiles: [{ id: 'mansi', name: 'Mansi', journeyConnected: false }], version: 'test', courseIdFrom: 'course.json', folderCourseId: course.id };
  window.location.hash = '';
  if (root !== null) act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

// Review finding (2026-10-01): a browser with no progress copy (cleared site data, a second browser on
// this Mac) opened at #/watch/<id> overwrote the newer SSD copy. WatchScreen's mount effect stamped
// `withLast` before ProfileApp's effect called `store.hydrate()` (React runs child passive effects
// first), so the empty local copy beat the SSD copy and was PUT over it.
describe('<App/> boot at #/watch/<id> with no local progress', () => {
  it('keeps the SSD progress instead of overwriting it', async () => {
    const { puts } = stubServer(Promise.resolve(ssdCopy));
    vi.spyOn(console, 'error').mockImplementation(() => undefined); // jsdom: scrollTo / media not implemented
    window.location.hash = `#/watch/${encodeURIComponent(ids[2] as string)}`;

    await mount(50);

    const local = JSON.parse(localStorage.getItem(progressKey(course.id, 'mansi')) ?? 'null') as ProgressState | null;
    expect(local?.lectures[ids[0] as string]?.done).toBe(true);
    expect(local?.days['2026-09-30']).toBe(5400);
    for (const p of puts) expect(p.lectures[ids[0] as string]?.done).toBe(true);
  });

  it('mounts no screen until the SSD copy is read, so Watch resumes from the SSD position', async () => {
    let release: (s: ProgressState) => void = () => undefined;
    stubServer(new Promise<ProgressState>((r) => (release = r)));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    window.location.hash = `#/watch/${encodeURIComponent(ids[1] as string)}`;

    const el = await mount(20);
    expect(el.querySelector('[data-state="loading"]')).not.toBeNull();
    expect(el.querySelector('[data-player]')).toBeNull();

    await act(async () => {
      release(ssdCopy);
      await tick(20);
    });
    expect(el.querySelector('[data-player]')).not.toBeNull();
  });
});

describe('<App/> v2: one learner', () => {
  it('opens straight to her home — no "Who\'s studying?", Start studying in the header (v3)', async () => {
    stubServer(Promise.resolve(ssdCopy));
    const el = await mount(50);
    expect(el.textContent).not.toContain('Who’s studying?');
    expect(el.querySelector('[data-control="start-studying"]')?.textContent).toContain('Start studying');
    expect(el.querySelector('[data-control="sign-off"]')).toBeNull();
    expect(el.querySelector('[data-control="continue"]')).not.toBeNull();
  });
});

describe('<App/> v3: the study timer', () => {
  it('Start studying → the header chip; its name says both "Sign off" and the time', async () => {
    stubServer(Promise.resolve(ssdCopy));
    const el = await mount(50);
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-control="start-studying"]')?.click();
      await tick(0);
    });
    const chip = el.querySelector('[data-control="sign-off"]');
    expect(chip?.getAttribute('aria-label')).toBe('Sign off — studying for less than 1 min');
    expect(chip?.textContent).toContain('<1m');
    expect(el.querySelector('[data-control="start-studying"]')).toBeNull();
    expect(el.querySelector('[data-control="start-studying-hero"]')).toBeNull();
  });

  it('a timer started before a reload / restart is still running at the next open', async () => {
    stubServer(Promise.resolve(ssdCopy));
    localStorage.setItem(studyKey(course.id, 'mansi'), JSON.stringify(newSession('kept', Date.now() - 83 * 60_000, false)));
    const el = await mount(50);
    expect(el.querySelector('[data-control="sign-off"]')?.getAttribute('aria-label')).toBe('Sign off — studying for 1 h 23 min');
  });

  it('opening an article lecture with no timer starts it, with the quiet notice', async () => {
    stubServer(Promise.resolve(ssdCopy));
    vi.spyOn(console, 'error').mockImplementation(() => undefined); // jsdom: scrollTo not implemented
    const article = course.sections[1]?.lectures[1]?.id as string;
    window.location.hash = `#/watch/${encodeURIComponent(article)}`;
    const el = await mount(50);
    expect(el.querySelector('[data-control="sign-off"]')).not.toBeNull();
    expect(el.querySelector('[data-notice="timer-started"]')?.textContent).toBe('Study timer started');
  });

  it('Quit with the timer running opens the card as "Send & quit"', async () => {
    stubServer(Promise.resolve(ssdCopy));
    localStorage.setItem(studyKey(course.id, 'mansi'), JSON.stringify(newSession('kept', Date.now() - 30 * 60_000, false)));
    const el = await mount(50);
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[aria-label="Quit the course player"]')?.click();
      await tick(0);
    });
    expect(document.querySelector('[data-control="signoff-primary"]')?.textContent).toBe('Send & quit');
  });
});

describe('<App/> v3: v2 study state left in this browser', () => {
  // 2026-10-05: nothing is dropped silently. A v2 session (under the old FOLDER course id too) is sent
  // once at open, as recorded — with the SSD copy's snapshot, not this browser's empty one — and no
  // card asks about it.
  it('is sent once at open (autoClosed), from the SSD progress, under the old folder id too', async () => {
    boot = { ...boot, folderCourseId: 'react-course' };
    const { sessions } = stubServer(Promise.resolve(ssdCopy));
    const tue = new Date(Date.now() - 3 * 86_400_000).getTime();
    localStorage.setItem(
      'cp:react-course:mansi:pending',
      JSON.stringify([
        {
          id: 'skipped-tue',
          startedAt: tue,
          lastStudyAt: tue + 72 * 60_000,
          seconds: 72 * 60,
          sectionSeconds: { 3: 72 * 60 },
          lecturesCompleted: [],
          finishedSections: [],
          skippedAt: tue + 86_400_000,
        },
      ]),
    );
    await mount(80);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(sessions.map((s) => [s.id, s.minutes, s.autoClosed, s.course])).toEqual([['skipped-tue', 72, true, course.id]]);
    expect(sessions[0]?.progress?.lecturesDone).toBe(1); // the SSD copy (ids[0] done), not the empty local one
    expect(localStorage.getItem('cp:react-course:mansi:pending')).toBeNull();
  });
});

describe('<App/> v2: connecting JS Journey', () => {
  // Review 2026-10-01: connecting from the header only updated the profile — no This week / From Rahul /
  // Due until a reload, a sign-off or a refocus 5 min later, and no snapshot for the coach.
  it('fetches her plan + feed and pushes her snapshot at once', async () => {
    const { calls } = stubServer(Promise.resolve(ssdCopy));
    await mount(50);
    // nothing that reaches JS Journey before she connects (the LOCAL outbox is read either way — v3)
    expect(calls.filter((c) => c.includes('/api/journey/') && !c.includes('/outbox'))).toEqual([]);
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[aria-label="Settings — theme and JS Journey"]')?.click();
      await tick(0);
    });
    await act(async () => {
      [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Connect JS Journey'))?.click();
      await tick(0);
    });
    await act(async () => {
      const input = document.querySelector<HTMLInputElement>('input[type="url"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'https://js-journey.example/m/token-1');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      await tick(0);
    });
    await act(async () => {
      input()?.form?.requestSubmit();
      await tick(30);
    });
    expect(calls).toEqual(expect.arrayContaining(['GET /api/journey/mansi/status', 'GET /api/journey/mansi/feed', 'PUT /api/journey/mansi/progress']));
  });
});

const input = (): HTMLInputElement | null => document.querySelector<HTMLInputElement>('input[type="url"]');

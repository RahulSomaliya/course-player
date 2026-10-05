// @vitest-environment jsdom
// <App/> end to end (fetch stubbed): boot → ProfileApp → the SSD progress copy.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BootPayload, JourneySession, ProgressState } from '../../../shared/types';
import { emptyProgress } from '../lib/progress';
import { sampleCourse } from '../lib/test-fixtures';
import { progressKey } from '../state/progress';
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
        sessions.push(JSON.parse(String(init?.body)) as JourneySession);
        return json({ pending: 1, lastError: null });
      }
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
  it('opens straight to her home — no "Who\'s studying?", Sign off in the header', async () => {
    stubServer(Promise.resolve(ssdCopy));
    const el = await mount(50);
    expect(el.textContent).not.toContain('Who’s studying?');
    expect(el.querySelector('[data-control="sign-off"]')?.textContent).toContain('Sign off');
    expect(el.querySelector('[data-control="continue"]')).not.toBeNull();
  });

  it('the next open after closing without signing off asks for that session\'s note', async () => {
    boot = { course, profiles: [{ id: 'mansi', name: 'Mansi', journeyConnected: true }], version: 'test', courseIdFrom: 'course.json', folderCourseId: course.id };
    stubServer(Promise.resolve(ssdCopy));
    const tue = new Date(Date.now() - 2 * 86_400_000);
    tue.setHours(19, 0, 0, 0);
    localStorage.setItem(
      `cp:${course.id}:mansi:session`,
      JSON.stringify({
        id: 'earlier',
        startedAt: tue.getTime(),
        lastStudyAt: tue.getTime() + 72 * 60_000,
        seconds: 72 * 60,
        sectionSeconds: { 3: 72 * 60 },
        lecturesCompleted: [],
        finishedSections: [],
      }),
    );
    await mount(80);
    const card = document.querySelector('[role="dialog"]');
    expect(card?.textContent).toMatch(/You studied 1h 12m (yesterday|on \w{3})/);
    expect(card?.textContent).toContain('Add a note for Rahul?');
    expect(document.querySelector('[data-control="sign-off"] [data-waiting]')).not.toBeNull();
  });
});

describe('<App/> v2: the 24 h rule at open', () => {
  // Review 2026-10-01 (high): resume() started the auto-close POST while the session stayed in
  // `pending`, so the at-open card asked about it too and dropped the note she typed. And it ran before
  // hydrate, so the update's snapshot came from this browser's (here: empty) copy, not the SSD's.
  it('a session she skipped that is now over 24 h old is sent for her — from the SSD progress — and the card does not ask', async () => {
    boot = { course, profiles: [{ id: 'mansi', name: 'Mansi', journeyConnected: true }], version: 'test', courseIdFrom: 'course.json', folderCourseId: course.id };
    const { sessions } = stubServer(Promise.resolve(ssdCopy));
    const tue = new Date(Date.now() - 3 * 86_400_000);
    localStorage.setItem(
      `cp:${course.id}:mansi:pending`,
      JSON.stringify([
        {
          id: 'skipped-tue',
          startedAt: tue.getTime(),
          lastStudyAt: tue.getTime() + 72 * 60_000,
          seconds: 72 * 60,
          sectionSeconds: { 3: 72 * 60 },
          lecturesCompleted: [],
          finishedSections: [],
          skippedAt: tue.getTime() + 86_400_000,
        },
      ]),
    );
    await mount(80);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(sessions.map((s) => [s.id, s.autoClosed])).toEqual([['skipped-tue', true]]);
    expect(sessions[0]?.progress?.lecturesDone).toBe(1); // the SSD copy (ids[0] done), not the empty local one
  });
});

describe('<App/> v2: connecting JS Journey', () => {
  // Review 2026-10-01: connecting from the header only updated the profile — no This week / From Rahul /
  // Due until a reload, a sign-off or a refocus 5 min later, and no snapshot for the coach.
  it('fetches her plan + feed and pushes her snapshot at once', async () => {
    const { calls } = stubServer(Promise.resolve(ssdCopy));
    await mount(50);
    expect(calls.filter((c) => c.includes('/api/journey/'))).toEqual([]);
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

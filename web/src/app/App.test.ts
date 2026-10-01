// @vitest-environment jsdom
// <App/> end to end (fetch stubbed): boot → ProfileApp → the SSD progress copy.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BootPayload, ProgressState } from '../../../shared/types';
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

const boot: BootPayload = { course, profiles: [{ id: 'mansi', name: 'Mansi', journeyConnected: false }], version: 'test' };
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** Stubs the course server; GET /api/progress/mansi answers when `progress` resolves. */
function stubServer(progress: Promise<ProgressState>): { puts: ProgressState[] } {
  const puts: ProgressState[] = [];
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
      return new Response(null, { status: 204 });
    }),
  );
  return { puts };
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
    localStorage.setItem('cp:profile', 'mansi');
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
    localStorage.setItem('cp:profile', 'mansi');
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

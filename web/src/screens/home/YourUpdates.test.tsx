// @vitest-environment jsdom
// "Your updates" with the outbox on top (spec v3 A6): an update still waiting, or one JS Journey refused,
// is listed — never silently absent — and a refused one can be sent again from here.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JourneyFeed, JourneySession, OutboxState, OutboxUpdate, StudentUpdate } from '../../../../shared/types';
import { AppContext, type AppValue } from '../../app/context';
import { indexCourse } from '../../lib/course';
import { sampleCourse } from '../../lib/test-fixtures';
import { JourneyContext, JourneyStore, type JourneyApi } from '../../state/journey';
import { YourUpdates } from './YourUpdates';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const course = sampleCourse();
const session = (id: string, note: string): JourneySession => ({
  id,
  course: course.id,
  startedAt: '2026-10-05T03:44:00.000Z',
  endedAt: '2026-10-05T05:07:00.000Z',
  studyDate: '2026-10-05',
  minutes: 83,
  sectionNumber: 3,
  lecturesCompleted: [],
  finishedSections: [],
  mood: null,
  note,
  stuck: false,
  autoClosed: false,
  progress: null,
});
const queued: OutboxUpdate = { id: 'q', state: 'queued', at: '2026-10-05T05:07:00.000Z', error: null, session: session('q', 'waiting words') };
const rejected: OutboxUpdate = { id: 'r', state: 'rejected', at: '2026-10-05T04:00:00.000Z', error: 'HTTP 404 — unknown course', session: session('r', 'refused words') };
const outboxOf = (updates: OutboxUpdate[]): OutboxState => ({ pending: 0, lastError: null, updates });

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function mount(opts: { outbox: OutboxUpdate[]; feed?: JourneyFeed | null; connected?: boolean; api?: Partial<JourneyApi> }) {
  const journey = new JourneyStore({
    courseId: course.id,
    profile: 'mansi',
    storage: null,
    isConnected: () => opts.connected ?? true,
    api: {
      status: async () => null,
      feed: async () => null,
      read: async () => undefined,
      outbox: async () => outboxOf(opts.outbox),
      retry: async () => outboxOf(opts.outbox),
      ...opts.api,
    },
  });
  journey.noteOutbox(outboxOf(opts.outbox));
  const app: AppValue = {
    course,
    index: indexCourse(course),
    profile: { id: 'mansi', name: 'Mansi', journeyConnected: opts.connected ?? true },
    openSignOff: () => undefined,
    openNote: () => undefined,
    quit: () => undefined,
    updateProfile: () => undefined,
  };
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const render = (): void =>
    root?.render(
      createElement(
        AppContext.Provider,
        { value: app },
        createElement(
          JourneyContext.Provider,
          { value: journey },
          createElement(YourUpdates, { feed: opts.feed ?? null, readIds: new Set<string>(), stale: false, outbox: journey.get().outbox }),
        ),
      ),
    );
  act(render);
  return { host, journey, render };
}

describe('Your updates: her updates still in the outbox (spec v3 A6)', () => {
  it('shown on top even with no feed yet: "Waiting to send" and "Didn’t reach Rahul — <reason> · Try again"', () => {
    const { host } = mount({ outbox: [rejected, queued] });
    const items = [...host.querySelectorAll('article')];
    expect(items.map((a) => a.querySelector('[data-outbox]')?.getAttribute('data-outbox'))).toEqual(['queued', 'rejected']);
    expect(items[0]?.textContent).toContain('waiting words');
    expect(items[0]?.textContent).toContain('Waiting to send');
    expect(items[1]?.textContent).toContain('Didn’t reach Rahul — unknown course (HTTP 404)');
    expect(items[1]?.querySelector('button')?.textContent).toBe('Try again');
  });

  it('not connected: the waiting line says what makes it go', () => {
    const { host } = mount({ outbox: [queued], connected: false });
    expect(host.textContent).toContain('Waiting to send · connect JS Journey in the settings menu');
  });

  it('Try again re-queues exactly that update', async () => {
    const retried: string[][] = [];
    const { host } = mount({
      outbox: [rejected],
      api: {
        retry: async (ids) => {
          retried.push(ids);
          return outboxOf([{ ...rejected, state: 'queued', error: null } as OutboxUpdate]);
        },
        outbox: async () => outboxOf([{ id: 'r', state: 'delivered', at: '2026-10-05T06:00:00.000Z', error: null }]),
      },
    });
    await act(async () => host.querySelector<HTMLButtonElement>('[data-outbox="rejected"] button')?.click());
    expect(retried).toEqual([['r']]);
  });

  it('an update the feed already has is listed once (from the feed)', () => {
    const feed: JourneyFeed = {
      updates: [{ ...({} as StudentUpdate), id: 'q', source: 'player', studyDate: '2026-10-05', createdAt: '2026-10-05T05:08:00Z', minutes: 83, sectionNumber: 3, sectionTitle: 'Components', lectures: [], mood: null, note: 'waiting words', stuck: false, coachReadAt: null, replies: [] }],
      notes: [],
      unreadForStudent: 0,
      nextCursor: null,
    };
    const { host } = mount({ outbox: [queued], feed });
    expect(host.querySelectorAll('article')).toHaveLength(1);
    expect(host.querySelector('[data-outbox]')).toBeNull();
  });

  it('nothing anywhere → no block', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { host } = mount({ outbox: [] });
    expect(host.querySelector('section')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import type { JourneyFeed, JourneySession, OutboxState, OutboxUpdate, StudentUpdate } from '../../../shared/types';
import { asStudentUpdate, deliveryOf, readableReason, waitingUpdates } from './outbox';
import { sampleCourse } from './test-fixtures';

const session = (id: string, over: Partial<JourneySession> = {}): JourneySession => ({
  id,
  course: 'react-2023',
  startedAt: '2026-10-05T03:44:00.000Z',
  endedAt: '2026-10-05T05:07:00.000Z',
  studyDate: '2026-10-05',
  minutes: 83,
  sectionNumber: 3,
  lecturesCompleted: [{ section: 3, lecture: 1, title: 'Props' }],
  finishedSections: [],
  mood: '🙂',
  note: 'props clicked',
  stuck: false,
  autoClosed: false,
  progress: null,
  ...over,
});
const queued = (id: string, at = '2026-10-05T05:07:00.000Z'): OutboxUpdate => ({ id, state: 'queued', at, error: null, session: session(id) });
const rejected = (id: string, error = 'HTTP 404 — unknown course'): OutboxUpdate => ({ id, state: 'rejected', at: '2026-10-05T05:08:00.000Z', error, session: session(id) });
const delivered = (id: string): OutboxUpdate => ({ id, state: 'delivered', at: '2026-10-05T05:09:00.000Z', error: null });
const outbox = (updates: OutboxUpdate[]): OutboxState => ({ pending: updates.filter((u) => u.state === 'queued').length, lastError: null, updates });

describe('deliveryOf: what became of the update she just sent (the sign-off confirmation, spec v3 A5)', () => {
  it('delivered / still queued / rejected with the reason / not listed', () => {
    const o = outbox([queued('q'), rejected('r'), delivered('d')]);
    expect(deliveryOf(o, 'd')).toEqual({ state: 'delivered' });
    expect(deliveryOf(o, 'q')).toEqual({ state: 'queued' });
    expect(deliveryOf(o, 'r')).toEqual({ state: 'rejected', error: 'HTTP 404 — unknown course' });
    expect(deliveryOf(o, 'zzz')).toEqual({ state: 'unknown' });
  });
});

describe('waitingUpdates: her updates still in the outbox, on top of "Your updates" (spec v3 A6)', () => {
  const feed = (ids: string[]): JourneyFeed => ({
    updates: ids.map((id) => ({ id }) as StudentUpdate),
    notes: [],
    unreadForStudent: 0,
    nextCursor: null,
  });

  it('queued and rejected ones, newest first; delivered ones come from the feed', () => {
    const list = [rejected('r'), queued('q2', '2026-10-05T06:00:00.000Z'), delivered('d'), queued('q1')];
    expect(waitingUpdates(list, null).map((w) => [w.session.id, w.state])).toEqual([
      ['q2', 'queued'],
      ['r', 'rejected'],
      ['q1', 'queued'],
    ]);
  });

  it('one already in the feed is not listed twice (the outbox copy was older than the feed)', () => {
    expect(waitingUpdates([queued('q1'), rejected('r')], feed(['q1'])).map((w) => w.session.id)).toEqual(['r']);
  });
});

describe('asStudentUpdate: a waiting update in the feed\'s layout', () => {
  it('its section title from the course; no replies; createdAt = when she sent it', () => {
    expect(asStudentUpdate(session('q'), sampleCourse())).toEqual({
      id: 'q',
      source: 'player',
      studyDate: '2026-10-05',
      createdAt: '2026-10-05T05:07:00.000Z',
      minutes: 83,
      sectionNumber: 3,
      sectionTitle: 'Components',
      lectures: [{ section: 3, lecture: 1, title: 'Props' }],
      mood: '🙂',
      note: 'props clicked',
      stuck: false,
      coachReadAt: null,
      replies: [],
    });
  });
});

describe('readableReason: the outbox error in her words', () => {
  it('"HTTP 404 — unknown course" → "unknown course (HTTP 404)"; anything else as is', () => {
    expect(readableReason('HTTP 404 — unknown course')).toBe('unknown course (HTTP 404)');
    expect(readableReason('HTTP 400 — minutes must be ≤ 1440')).toBe('minutes must be ≤ 1440 (HTTP 400)');
    expect(readableReason('JS Journey refused it')).toBe('JS Journey refused it');
  });
});

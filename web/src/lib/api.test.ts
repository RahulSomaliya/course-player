import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JourneyProblem, JourneySession, OutboxState } from '../../../shared/types';
import { ApiError, connectJourney, getJourneyStatus, getOutbox, postSession, retryOutbox } from './api';

type Call = { url: string; init: RequestInit | undefined };

/** fetch answering `status` + `body` (JSON), recording the calls. */
function serve(status: number, body?: unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

const PROBLEM: JourneyProblem = {
  error: "JS Journey doesn't know the course 'react-course' — this copy's course id is wrong; ask Rahul.",
  problem: 'unknown-course',
  courseId: 'react-course',
};
const OUTBOX: OutboxState = { pending: 0, lastError: null, updates: [{ id: 's1', state: 'delivered', at: '2026-10-05T10:00:00.000Z', error: null }] };

describe('JS Journey problems are typed, not just a status code', () => {
  it('getJourneyStatus: 409 throws an ApiError carrying the JourneyProblem; 204 is null', async () => {
    serve(409, PROBLEM);
    const err = await getJourneyStatus('mansi').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, message: PROBLEM.error, problem: PROBLEM });
    serve(204);
    expect(await getJourneyStatus('mansi')).toBeNull();
  });

  it('connectJourney: the 409 problem rides on the ApiError too; other errors have problem null', async () => {
    serve(409, PROBLEM);
    await expect(connectJourney('mansi', 'https://jj.example/m/t')).rejects.toMatchObject({ status: 409, problem: PROBLEM });
    serve(502, { error: 'JS Journey did not accept this link (HTTP 401 — Unknown token).' });
    await expect(connectJourney('mansi', 'https://jj.example/m/t')).rejects.toMatchObject({ status: 502, problem: null });
    serve(409, { error: 'some other conflict' }); // a 409 without a problem shape is not one
    await expect(connectJourney('mansi', 'https://jj.example/m/t')).rejects.toMatchObject({ status: 409, problem: null });
  });
});

describe('outbox', () => {
  it('getOutbox asks the server to wait (bounded) for the delivery in flight', async () => {
    const calls = serve(200, OUTBOX);
    expect(await getOutbox('mansi', { waitMs: 8000 })).toEqual(OUTBOX);
    expect(await getOutbox('mansi')).toEqual(OUTBOX);
    expect(calls.map((c) => c.url)).toEqual(['/api/journey/mansi/outbox?wait=8000', '/api/journey/mansi/outbox']);
  });

  it('retryOutbox POSTs (CSRF header) all, or only the given ids', async () => {
    const calls = serve(202, OUTBOX);
    expect(await retryOutbox('mansi')).toEqual(OUTBOX);
    await retryOutbox('mansi', ['s1']);
    expect(calls.map((c) => [c.url, c.init?.method, c.init?.body])).toEqual([
      ['/api/journey/mansi/outbox/retry', 'POST', '{}'],
      ['/api/journey/mansi/outbox/retry', 'POST', '{"ids":["s1"]}'],
    ]);
    expect(new Headers(calls[0]?.init?.headers).get('x-course-player')).toBe('1');
  });

  it('postSession returns the outbox as saved (v3: also while not connected)', async () => {
    const session: JourneySession = {
      id: 's2',
      course: 'react-2023',
      startedAt: '2026-10-05T09:00:00.000Z',
      endedAt: '2026-10-05T10:00:00.000Z',
      studyDate: '2026-10-05',
      minutes: 60,
      sectionNumber: 3,
      lecturesCompleted: [],
      finishedSections: [],
      mood: null,
      note: null,
      stuck: false,
      autoClosed: false,
      progress: null,
    };
    const calls = serve(202, { ...OUTBOX, pending: 1 });
    expect((await postSession('mansi', session)).pending).toBe(1);
    expect(calls[0]?.init?.body).toBe(JSON.stringify(session));
  });
});

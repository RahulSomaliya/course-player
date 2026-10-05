import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { JourneyFeed, JourneySession, JourneyStatus, PlanRow, ProgressSnapshot } from '../shared/types.ts';
import { ConfigStore } from './config.ts';
import {
  AlreadyDelivered,
  Journey,
  isJourneyFeed,
  markRead,
  parseJourneyStatus,
  parseReadIds,
  parseStudentLink,
  validateProgressSnapshot,
  validateSession,
} from './journey.ts';
import {
  M_NOTE,
  M_REPLY,
  coachMessage,
  feed,
  makeTempDir,
  msgId,
  memoryLog,
  session,
  snapshot,
  startStubJourney,
  type SeenRequest,
  type StubJourney,
} from './test-helpers.ts';

const TOKEN = 'stu_tok_9f8e7d6c5b4a';

const status: JourneyStatus = {
  pace: 'behind',
  daysDelta: -2,
  week: 3,
  totalWeeks: 10,
  targetDate: '2026-12-11',
  deadline: '2026-12-18',
  goal: { sectionNumber: 7, title: 'Thinking In React', due: '2026-10-16' },
  coachNote: { body: 'Keep going', createdAt: '2026-10-04T08:00:00.000Z' },
  planBreak: null,
  sectionDue: { '3': '2026-10-09', '5': '2026-10-16' },
  skippedSections: [4],
  studyWeekdays: [1, 2, 3, 4, 5],
  planBreaks: [{ label: 'Diwali', start: '2026-11-01', end: '2026-11-15' }],
};
/** what the fields added since v1 default to when an older JS Journey omits them */
const V1_DEFAULTS = { planBreak: null, sectionDue: {}, skippedSections: [], studyWeekdays: [1, 2, 3, 4, 5], planBreaks: [] };

// ---- stub JS Journey -----------------------------------------------------------------------

let stub: StubJourney;
let stubOrigin = '';
let seen: SeenRequest[] = [];
let reply: (req: SeenRequest) => { status: number; body?: unknown } = () => ({ status: 200, body: {} });

beforeAll(async () => {
  stub = await startStubJourney();
  stubOrigin = stub.origin;
  seen = stub.seen;
  stub.setReply((req) => reply(req));
});
afterAll(() => stub.close());

let dir = '';
let cleanup: () => Promise<void> = async () => {};
let config: ConfigStore;
let journey: Journey;
let logged: string[] = [];

async function makeJourney(): Promise<Journey> {
  const { log, lines } = memoryLog();
  logged = lines;
  config = await ConfigStore.load(dir);
  return new Journey({ dataDir: dir, config, courseId: 'react-2023', log, timeoutMs: 1000 });
}

beforeEach(async () => {
  ({ dir, cleanup } = await makeTempDir('journey'));
  seen.length = 0;
  reply = () => ({ status: 200, body: {} });
  await writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({
      profiles: [
        { id: 'rahul', name: 'Rahul' },
        { id: 'mansi', name: 'Mansi', journeyLink: `${stubOrigin}/m/${TOKEN}` },
      ],
    }),
  );
  journey = await makeJourney();
});
afterEach(async () => {
  await journey.settled('mansi'); // a write's background delivery must not outlive the temp dir
  expect(logged.join('\n')).not.toContain(TOKEN);
  await cleanup();
});

describe('parseStudentLink', () => {
  it('accepts https://<host>/m/<token> and loopback http (dev/tests)', () => {
    expect(parseStudentLink('https://js-journey-ten.vercel.app/m/abc_DEF-123')).toEqual({
      origin: 'https://js-journey-ten.vercel.app',
      token: 'abc_DEF-123',
    });
    expect(parseStudentLink('  https://jj.example/m/abc123/  ')).toEqual({ origin: 'https://jj.example', token: 'abc123' });
    expect(parseStudentLink('http://127.0.0.1:4000/m/abc123')?.origin).toBe('http://127.0.0.1:4000');
  });

  it('rejects everything else', () => {
    for (const bad of ['', 'hello', 'http://jj.example/m/abc123', 'https://jj.example/s/abc123', 'https://jj.example/m/', 'https://u:p@jj.example/m/abc123', 'https://jj.example/m/a/b', 42]) {
      expect(parseStudentLink(bad)).toBeNull();
    }
  });
});

describe('validation', () => {
  const v = (x: unknown): string | null => validateSession(x, 'react-2023');

  it('validateSession accepts a JourneySession and names the bad field otherwise', () => {
    expect(v(session('s1'))).toBeNull();
    expect(v(session('s1', { minutes: 0 }))).toMatch(/minutes/);
    expect(v(session('s1', { minutes: 1.5 }))).toMatch(/minutes/);
    expect(v(session('s1', { course: 'vue' }))).toMatch(/course/);
    expect(v(session('s1', { studyDate: '5 Oct' }))).toMatch(/studyDate/);
    expect(v(session('s1', { mood: '🤖' }))).toMatch(/mood/);
    expect(v(session('s1', { lecturesCompleted: [{ section: 1, lecture: 1 } as never] }))).toMatch(/lecturesCompleted/);
    expect(v(null)).not.toBeNull();
  });

  // Review 2026-10-01: JS Journey 400s these, and the outbox drops a 4xx'd update for good — so they are
  // refused here, where the browser still has the session and can say so.
  it('validateSession matches JS Journey: sectionNumber >= 1, minutes <= 1440', () => {
    expect(v(session('s1', { sectionNumber: 0 }))).toMatch(/sectionNumber/);
    expect(v(session('s1', { minutes: 1440 }))).toBeNull();
    expect(v(session('s1', { minutes: 1441 }))).toMatch(/minutes/);
  });

  it('validateSession v2: stuck + autoClosed are booleans, progress is a snapshot of this course or null', () => {
    expect(v(session('s1', { stuck: true, autoClosed: true, progress: null }))).toBeNull();
    const { stuck: _s, ...noStuck } = session('s1');
    expect(v(noStuck)).toMatch(/stuck/);
    expect(v({ ...session('s1'), autoClosed: 'yes' })).toMatch(/autoClosed/);
    const { progress: _p, ...noProgress } = session('s1');
    expect(v(noProgress)).toMatch(/progress/);
    expect(v(session('s1', { progress: snapshot(1, { course: 'vue' }) }))).toMatch(/progress/);
    expect(v(session('s1', { progress: { ...snapshot(1), days: { yesterday: 60 } } }))).toMatch(/progress/);
  });

  it('validateSession v2: minutes may be 0 only for a note-only update (she studied away from the player)', () => {
    expect(v(session('s1', { minutes: 0, note: 'Read the useEffect docs on the train' }))).toBeNull();
    expect(v(session('s1', { minutes: 0, note: null }))).toMatch(/minutes/);
    expect(v(session('s1', { minutes: 0, note: '   ' }))).toMatch(/minutes/);
    expect(v(session('s1', { minutes: -1, note: 'x' }))).toMatch(/minutes/);
  });

  it('validateProgressSnapshot checks every field', () => {
    const p = (x: unknown): string | null => validateProgressSnapshot(x, 'react-2023');
    expect(p(snapshot(1))).toBeNull();
    expect(p(snapshot(1, { current: null, days: {}, sectionsDone: [] }))).toBeNull();
    expect(p(snapshot(1, { course: 'vue' }))).toMatch(/course/);
    expect(p({ ...snapshot(1), takenAt: '2026-10-05' })).toMatch(/takenAt/);
    expect(p(snapshot(1, { lecturesDone: -1 }))).toMatch(/lecturesDone/);
    expect(p(snapshot(1, { lecturesTotal: 2.5 }))).toMatch(/lecturesTotal/);
    expect(p(snapshot(1, { videoSecondsDone: Number.NaN }))).toMatch(/videoSecondsDone/);
    expect(p({ ...snapshot(1), videoSecondsTotal: null })).toMatch(/videoSecondsTotal/);
    expect(p(snapshot(1, { sectionsDone: [1, -2] }))).toMatch(/sectionsDone/);
    expect(p({ ...snapshot(1), current: { sectionNumber: 3, title: 'x' } })).toMatch(/current/);
    expect(p(snapshot(1, { days: { '2026-10-05': -5 } }))).toMatch(/days/);
    expect(p([])).not.toBeNull();
  });

  it('parseReadIds wants 1–500 message ids — uuids, as JS Journey checks — and dedups them', () => {
    expect(parseReadIds({ ids: [M_REPLY, M_NOTE, M_REPLY] })).toEqual({ ok: true, ids: [M_REPLY, M_NOTE] });
    for (const bad of [null, {}, { ids: [] }, { ids: M_REPLY }, { ids: [''] }, { ids: [7] }, { ids: ['r-wed'] }, { ids: [M_REPLY, 'x'.repeat(36)] }]) {
      expect(parseReadIds(bad)).toMatchObject({ ok: false });
    }
    expect(parseReadIds({ ids: Array.from({ length: 501 }, (_, i) => msgId(i)) })).toMatchObject({ ok: false });
  });

  it('parseJourneyStatus checks the shape', () => {
    expect(parseJourneyStatus(status)).toEqual(status);
    expect(parseJourneyStatus({ ...status, pace: 'fast' })).toBeNull();
    expect(parseJourneyStatus({ ...status, goal: { title: 'x' } })).toBeNull();
  });

  it('parseJourneyStatus checks sectionDue + skippedSections; an older JS Journey omits them (normalized to empty)', () => {
    expect(parseJourneyStatus({ ...status, sectionDue: { '3': '9 Oct' } })).toBeNull();
    expect(parseJourneyStatus({ ...status, sectionDue: { three: '2026-10-09' } })).toBeNull();
    expect(parseJourneyStatus({ ...status, sectionDue: [] })).toBeNull();
    expect(parseJourneyStatus({ ...status, skippedSections: ['4'] })).toBeNull();
    expect(parseJourneyStatus({ ...status, skippedSections: 4 })).toBeNull();
    const { sectionDue: _d, skippedSections: _s, planBreak: _b, studyWeekdays: _w, planBreaks: _p, ...v1 } = status;
    expect(parseJourneyStatus(v1)).toEqual({ ...status, ...V1_DEFAULTS });
  });

  it('parseJourneyStatus checks the plan calendar the streak walks (studyWeekdays + every break)', () => {
    expect(parseJourneyStatus({ ...status, studyWeekdays: [1, 2, 3, 4, 5, 6, 7], planBreaks: [] })).toEqual({
      ...status,
      studyWeekdays: [1, 2, 3, 4, 5, 6, 7],
      planBreaks: [],
    });
    expect(parseJourneyStatus({ ...status, studyWeekdays: [0, 1] })).toBeNull(); // ISO: 1 = Mon … 7 = Sun
    expect(parseJourneyStatus({ ...status, studyWeekdays: [8] })).toBeNull();
    expect(parseJourneyStatus({ ...status, studyWeekdays: ['1'] })).toBeNull();
    expect(parseJourneyStatus({ ...status, studyWeekdays: 5 })).toBeNull();
    expect(parseJourneyStatus({ ...status, planBreaks: null })).toBeNull();
    expect(parseJourneyStatus({ ...status, planBreaks: [{ label: 'Diwali', start: '2026-11-16', end: '2026-11-15' }] })).toBeNull();
    expect(parseJourneyStatus({ ...status, planBreaks: [{ start: '2026-11-01', end: '2026-11-15' }] })).toBeNull();
    // a JS Journey deployed before them: Mon–Fri, no breaks (the player's own default without a status)
    const { studyWeekdays: _w, planBreaks: _p, ...older } = status;
    expect(parseJourneyStatus(older)).toEqual({ ...status, studyWeekdays: [1, 2, 3, 4, 5], planBreaks: [] });
  });

  it('parseJourneyStatus checks planBreak (Mansi\'s 1–15 Nov Diwali break)', () => {
    const diwali = { label: 'Diwali break', start: '2026-11-01', end: '2026-11-15' };
    expect(parseJourneyStatus({ ...status, planBreak: diwali })).toEqual({ ...status, planBreak: diwali });
    expect(parseJourneyStatus({ ...status, planBreak: 'Diwali' })).toBeNull();
    expect(parseJourneyStatus({ ...status, planBreak: { ...diwali, label: 7 } })).toBeNull();
    expect(parseJourneyStatus({ ...status, planBreak: { ...diwali, start: '1 Nov' } })).toBeNull();
    expect(parseJourneyStatus({ ...status, planBreak: { ...diwali, end: undefined } })).toBeNull();
    expect(parseJourneyStatus({ ...status, planBreak: { ...diwali, start: '2026-11-16' } })).toBeNull(); // ends before it starts
  });

  it('isJourneyFeed checks updates, replies, notes, the unread count and the cursor', () => {
    expect(isJourneyFeed(feed())).toBe(true);
    expect(isJourneyFeed(feed({ updates: [], notes: [], unreadForStudent: 0, nextCursor: 'c2' }))).toBe(true);
    const u = feed().updates[0] as JourneyFeed['updates'][number];
    expect(isJourneyFeed(feed({ updates: [{ ...u, source: 'manual', sectionNumber: null, sectionTitle: null, mood: null, note: null }] }))).toBe(true);
    expect(isJourneyFeed({ ...feed(), updates: undefined })).toBe(false);
    expect(isJourneyFeed(feed({ updates: [{ ...u, source: 'phone' as never }] }))).toBe(false);
    expect(isJourneyFeed(feed({ updates: [{ ...u, stuck: 'no' as never }] }))).toBe(false);
    expect(isJourneyFeed(feed({ updates: [{ ...u, replies: [{ id: 'm', body: 'x' } as never] }] }))).toBe(false);
    expect(isJourneyFeed(feed({ notes: [coachMessage('n', { readAt: 5 as never })] }))).toBe(false);
    expect(isJourneyFeed(feed({ unreadForStudent: -1 }))).toBe(false);
    expect(isJourneyFeed(feed({ nextCursor: 3 as never }))).toBe(false);
  });

  it('isJourneyFeed: unreadReplies (first page: older updates with a reply she has not seen) is optional but checked', () => {
    const u = feed().updates[0] as JourneyFeed['updates'][number];
    expect(isJourneyFeed(feed({ unreadReplies: [u] }))).toBe(true);
    expect(isJourneyFeed(feed({ unreadReplies: 'x' as never }))).toBe(false);
    expect(isJourneyFeed(feed({ unreadReplies: [{ ...u, stuck: 'no' as never }] }))).toBe(false);
  });

  it('markRead also marks a reply that rides on unreadReplies (else "From Rahul" brings it back from the cached copy)', () => {
    const at = '2026-10-06T08:00:00.000Z';
    const u = feed().updates[0] as JourneyFeed['updates'][number];
    const page = feed({ updates: [], unreadReplies: [u] });
    const read = markRead(page, [{ id: M_REPLY, at }]);
    expect(read.unreadReplies?.[0]?.replies[0]?.readAt).toBe(at);
    expect(read.unreadForStudent).toBe(page.unreadForStudent - 1);
  });

  it('markRead sets readAt on the acknowledged replies + notes and lowers the unread count (idempotent)', () => {
    const at = '2026-10-06T08:00:00.000Z';
    const read = markRead(feed(), [
      { id: M_REPLY, at },
      { id: 'm-other', at },
    ]);
    expect(read.updates[0]?.replies[0]?.readAt).toBe(at);
    expect(read.notes[0]?.readAt).toBeNull();
    expect(read.unreadForStudent).toBe(1);
    expect(markRead(read, [{ id: M_REPLY, at: 'later' }])).toBe(read); // unchanged -> the same object
    expect(markRead(feed(), [{ id: M_REPLY, at }, { id: M_NOTE, at }]).unreadForStudent).toBe(0);
    expect(markRead(feed({ unreadForStudent: 0 }), [{ id: M_REPLY, at }]).unreadForStudent).toBe(0); // never negative
    const page = feed();
    expect(markRead(page, [{ id: '__proto__', at }])).toBe(page); // outside ids are data, never object keys
  });
});

describe('outbox', () => {
  it('2xx: sends with the Bearer token and removes the session', async () => {
    reply = () => ({ status: 201, body: { ok: true } });
    expect(await journey.enqueue('mansi', session('s1'))).toMatchObject({ pending: 1, lastError: null }); // saved, not yet sent
    expect(await journey.settled('mansi')).toMatchObject({ pending: 0, lastError: null });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/api/player/sessions', auth: `Bearer ${TOKEN}` });
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual(session('s1'));
    expect(await journey.settled('mansi')).toMatchObject({ pending: 0, lastError: null });
    expect(logged).toContain('[journey] mansi: sent 1, 0 pending');
  });

  it('4xx: takes the session out of the queue (no endless retries) but KEEPS it as rejected (v3: never dropped)', async () => {
    reply = () => ({ status: 422, body: { error: 'Session overlaps another one' } });
    await journey.enqueue('mansi', session('s1'));
    const state = await journey.settled('mansi');
    expect(state).toMatchObject({ pending: 0, lastError: 'HTTP 422 — Session overlaps another one' });
    expect(state.updates).toEqual([
      { id: 's1', state: 'rejected', at: expect.any(String), error: 'HTTP 422 — Session overlaps another one', session: session('s1') },
    ]);
    expect(logged.some((l) => l.startsWith('[journey] mansi: HTTP 422 — Session overlaps another one (session s1 kept as rejected)'))).toBe(true);
    // a later success clears lastError; the rejected one stays until re-queued
    reply = () => ({ status: 200 });
    await journey.enqueue('mansi', session('s2'));
    const after = await journey.settled('mansi');
    expect(after).toMatchObject({ pending: 0, lastError: null });
    expect(after.updates.map((u) => [u.id, u.state])).toEqual(
      expect.arrayContaining([
        ['s1', 'rejected'],
        ['s2', 'delivered'],
      ]),
    );
    expect((await outboxOnDisk()).rejected).toHaveLength(1);
  });

  it('5xx: keeps the session, survives a restart, and delivers it on the next flush', async () => {
    reply = () => ({ status: 503, body: { message: 'maintenance' } });
    await journey.enqueue('mansi', session('s1'));
    expect(await journey.settled('mansi')).toMatchObject({ pending: 1, lastError: 'HTTP 503 — maintenance' });
    expect(await journey.enqueue('mansi', session('s2'))).toMatchObject({ pending: 2, lastError: 'HTTP 503 — maintenance' });
    expect(await journey.settled('mansi')).toMatchObject({ pending: 2, lastError: 'HTTP 503 — maintenance' });
    // her updates stay in order: after a 5xx on the oldest, the newer ones wait for the next flush
    expect(seen.filter((s) => s.method === 'POST')).toHaveLength(2);

    const restarted = await makeJourney();
    reply = () => ({ status: 200 });
    expect(await restarted.flush('mansi')).toMatchObject({ pending: 0, lastError: null });
    expect(seen.slice(-2).map((s) => (JSON.parse(s.body) as JourneySession).id)).toEqual(['s1', 's2']);
  });

  it('an unreachable JS Journey keeps the session pending', async () => {
    await config.setJourneyLink('mansi', `http://127.0.0.1:9/m/${TOKEN}`);
    await journey.enqueue('mansi', session('s1'));
    const state = await journey.settled('mansi');
    expect(state.pending).toBe(1);
    expect(state.lastError).toMatch(/^unreachable/);
  });

  it('re-posting a pending session id replaces it instead of duplicating it', async () => {
    reply = () => ({ status: 500 });
    await journey.enqueue('mansi', session('s1', { note: 'first' }));
    expect((await journey.enqueue('mansi', session('s1', { note: 'second' })))?.pending).toBe(1);
  });

  it('v3: accepts sessions for a profile without a JS Journey link, keeps them, and sends none', async () => {
    expect(await journey.enqueue('rahul', session('s1'))).toMatchObject({ pending: 1, lastError: null });
    expect(await journey.settled('rahul')).toMatchObject({ pending: 1, updates: [{ id: 's1', state: 'queued' }] });
    expect((await readdir(dir)).filter((f) => f.startsWith('outbox'))).toEqual(['outbox-rahul.json']);
    expect(seen).toEqual([]);
  });

  it('moves an unreadable outbox aside instead of crashing or silently dropping it', async () => {
    await writeFile(path.join(dir, 'outbox-mansi.json'), '{"items": [tru');
    expect(await journey.settled('mansi')).toMatchObject({ pending: 0, lastError: null });
    expect(await readdir(dir)).toContain('outbox-mansi.json.corrupt');
    expect(logged).toContain('[journey] mansi: outbox-mansi.json is unreadable — moved aside to outbox-mansi.json.corrupt');
  });

  it('a flush whose deadline already passed sends nothing and keeps lastError', async () => {
    reply = () => ({ status: 503, body: { message: 'down' } });
    await journey.enqueue('mansi', session('s1'));
    await journey.settled('mansi'); // the delivery the enqueue started
    const before = seen.length;
    expect(await journey.flush('mansi', Date.now() - 1)).toMatchObject({ pending: 1, lastError: 'HTTP 503 — down' });
    expect(seen.length).toBe(before);
  });

  it('flushAll respects its deadline', async () => {
    reply = () => ({ status: 500 });
    await journey.enqueue('mansi', session('s1'));
    await journey.settled('mansi');
    const slow = http.createServer(() => {
      /* never answers */
    });
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
    await config.setJourneyLink('mansi', `http://127.0.0.1:${(slow.address() as AddressInfo).port}/m/${TOKEN}`);
    const t0 = Date.now();
    await journey.flushAll(300);
    expect(Date.now() - t0).toBeLessThan(900);
    expect((await journey.settled('mansi')).pending).toBe(1);
    slow.closeAllConnections();
    await new Promise<void>((r) => slow.close(() => r()));
  });
});

// Review 2026-10-01: every local write awaited the JS Journey round trip before its 202, so "Sending…"
// and "Got it" lasted a Vercel/Neon cold start plus the whole backlog — and a tab closed meanwhile lost
// the browser's bookkeeping, so the next open asked for the same session again.
describe('the 202 does not wait for JS Journey', () => {
  /** A JS Journey that answers every write after `ms`; `events` = arrivals and answers, in order. */
  async function slowJourney(ms: number): Promise<{ events: string[]; close: () => Promise<void> }> {
    const events: string[] = [];
    const server = http.createServer((req, res) => {
      const what = `${req.method} ${(req.url ?? '').split('?')[0]}`;
      events.push(`${what} in`);
      req.resume();
      req.on('end', () => {
        const answer = (): void => {
          events.push(`${what} out`);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(req.method === 'GET' ? feed() : { ok: true }));
        };
        if (req.method === 'GET') answer();
        else setTimeout(answer, ms);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    await config.setJourneyLink('mansi', `http://127.0.0.1:${(server.address() as AddressInfo).port}/m/${TOKEN}`);
    return {
      events,
      close: () =>
        new Promise<void>((r) => {
          server.closeAllConnections();
          server.close(() => r());
        }),
    };
  }

  it('answers as soon as the update is saved, then delivers it in the background', async () => {
    const slow = await slowJourney(400);
    const t0 = Date.now();
    expect(await journey.enqueue('mansi', session('s1'))).toMatchObject({ pending: 1, lastError: null });
    expect(await journey.enqueueReads('mansi', [M_REPLY])).toMatchObject({ pending: 1, lastError: null });
    expect(await journey.enqueueProgress('mansi', snapshot(5))).toMatchObject({ pending: 1, lastError: null });
    expect(Date.now() - t0).toBeLessThan(250);
    expect(await journey.settled('mansi')).toMatchObject({ pending: 0, lastError: null });
    expect(slow.events.filter((e) => e.endsWith(' out'))).toEqual(['POST /api/player/sessions out', 'POST /api/player/feed/read out', 'PUT /api/player/progress out']);
    await slow.close();
  });

  it('a feed fetched right after a sign-off waits for that update to reach JS Journey ("Your updates" shows it)', async () => {
    const slow = await slowJourney(200);
    await journey.enqueue('mansi', session('s1'));
    await journey.feed('mansi', null);
    expect(slow.events).toEqual(['POST /api/player/sessions in', 'POST /api/player/sessions out', 'GET /api/player/feed in', 'GET /api/player/feed out']);
    await slow.close();
  });
});

describe('status proxy + link check', () => {
  it('returns the JourneyStatus for a connected profile, asking for this course with the token', async () => {
    reply = () => ({ status: 200, body: status });
    expect(await journey.status('mansi')).toEqual({ kind: 'status', status });
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/api/player/status?course=react-2023', auth: `Bearer ${TOKEN}` });
  });

  it('fills the fields an older JS Journey omits, so the browser always gets the full contract', async () => {
    const { sectionDue: _d, skippedSections: _s, planBreak: _b, studyWeekdays: _w, planBreaks: _p, ...v1 } = status;
    reply = () => ({ status: 200, body: v1 });
    expect(await journey.status('mansi')).toEqual({ kind: 'status', status: { ...status, ...V1_DEFAULTS } });
  });

  it('none when not connected, on non-2xx, or for an unexpected body', async () => {
    expect(await journey.status('rahul')).toEqual({ kind: 'none' });
    reply = () => ({ status: 500, body: { error: 'boom' } });
    expect(await journey.status('mansi')).toEqual({ kind: 'none' });
    reply = () => ({ status: 200, body: { hello: 'world' } });
    expect(await journey.status('mansi')).toEqual({ kind: 'none' });
    reply = () => ({ status: 204 });
    expect(await journey.status('mansi')).toEqual({ kind: 'none' });
    // a 404 that is not JS Journey's "unknown course" (a wrong host, an old deploy) is not the course's fault
    reply = () => ({ status: 404, body: { error: 'Not found' } });
    expect(await journey.status('mansi')).toEqual({ kind: 'none' });
  });

  // 2026-10-05: her copy asked about "react-course"; JS Journey 404'd and the player showed nothing at all.
  it('v3: JS Journey 404 "unknown course" is a problem the browser sees, naming the id (never a silent none)', async () => {
    reply = () => ({ status: 404, body: { error: 'unknown course "react-2023"' } });
    const result = await journey.status('mansi');
    expect(result).toEqual({
      kind: 'problem',
      problem: { problem: 'unknown-course', courseId: 'react-2023', error: expect.stringContaining("'react-2023'") as unknown },
    });
    expect(logged.some((l) => l.includes('mansi: status HTTP 404 — unknown course'))).toBe(true);
  });

  it('v3: passes the plan through, and drops (logged) a malformed plan without losing the status', async () => {
    const plan: PlanRow[] = [
      { kind: 'week', week: 1, due: '2026-10-09', goal: '§3 A First Look at React', state: 'current' },
      { kind: 'break', label: 'Diwali', start: '2026-11-01', end: '2026-11-15', now: false },
      { kind: 'week', week: 5, due: '2026-11-20', goal: 'Keep going: §29 …', state: 'upcoming' },
    ];
    reply = () => ({ status: 200, body: { ...status, plan } });
    expect(await journey.status('mansi')).toEqual({ kind: 'status', status: { ...status, plan } });
    for (const bad of [{}, [{ kind: 'week', week: 1, due: '2026-10-09', goal: 'x', state: 'late' }], [{ kind: 'break', label: 'D', start: '2026-11-01', end: '2026-11-15' }]]) {
      reply = () => ({ status: 200, body: { ...status, plan: bad } });
      const r = await journey.status('mansi');
      expect(r).toEqual({ kind: 'status', status });
      expect(r.kind === 'status' && 'plan' in r.status).toBe(false);
    }
    expect(logged.filter((l) => l === '[journey] mansi: status plan has an unexpected shape — dropped')).toHaveLength(3);
  });

  it('checkLink: 400 for a malformed link, 502 when JS Journey rejects it, ok on 2xx', async () => {
    expect(await journey.checkLink('not a link')).toMatchObject({ ok: false, status: 400 });
    reply = () => ({ status: 401, body: { error: 'Unknown token' } });
    expect(await journey.checkLink(`${stubOrigin}/m/${TOKEN}`)).toMatchObject({ ok: false, status: 502 });
    reply = () => ({ status: 200, body: status });
    expect(await journey.checkLink(`${stubOrigin}/m/${TOKEN}`)).toEqual({ ok: true, link: `${stubOrigin}/m/${TOKEN}` });
    expect(await journey.checkLink(`http://127.0.0.1:9/m/${TOKEN}`)).toMatchObject({ ok: false, status: 502 });
  });

  it('v3 checkLink: a good link for a course JS Journey does not know is refused with 409, naming the id', async () => {
    reply = () => ({ status: 404, body: { error: 'unknown course "react-2023"' } });
    expect(await journey.checkLink(`${stubOrigin}/m/${TOKEN}`)).toEqual({
      ok: false,
      status: 409,
      message: "JS Journey doesn't know the course 'react-2023' — this copy's course id is wrong; ask Rahul.",
      problem: { problem: 'unknown-course', courseId: 'react-2023', error: "JS Journey doesn't know the course 'react-2023' — this copy's course id is wrong; ask Rahul." },
    });
  });
});

// ---- v2: feed, read receipts, progress snapshot -------------------------------------------

const DOWN = `http://127.0.0.1:9/m/${TOKEN}`; // nothing listens on port 9: "unreachable"

async function onDisk(name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(dir, name), 'utf8')) as unknown;
}

interface OutboxOnDisk {
  v: number;
  items: JourneySession[];
  rejected: { session: JourneySession; error: string; at: string }[];
  delivered: { id: string; at: string }[];
  reads: { id: string; at: string }[];
  progress: ProgressSnapshot | null;
  lastError: string | null;
}
const outboxOnDisk = async (): Promise<OutboxOnDisk> => (await onDisk('outbox-mansi.json')) as OutboxOnDisk;

/** Answers the feed with `page`, every write with 200. */
function serveFeed(page: JourneyFeed = feed()): void {
  reply = (req) => (req.url.startsWith('/api/player/feed?') ? { status: 200, body: page } : { status: 200, body: { ok: true } });
}

describe('feed', () => {
  it('forwards the first page with the token and caches it in the data dir', async () => {
    serveFeed();
    expect(await journey.feed('mansi', null)).toEqual({ feed: feed(), stale: false });
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/api/player/feed?course=react-2023', auth: `Bearer ${TOKEN}` });
    expect(await onDisk('feed-mansi.json')).toMatchObject({ feed: feed() });
  });

  it('forwards the cursor for later pages and does not cache them', async () => {
    const page2 = feed({ notes: [], unreadForStudent: 0, nextCursor: null });
    serveFeed(page2);
    expect(await journey.feed('mansi', 'c 2/x')).toEqual({ feed: page2, stale: false });
    expect(seen[0]?.url).toBe('/api/player/feed?course=react-2023&cursor=c%202%2Fx');
    expect(await readdir(dir)).not.toContain('feed-mansi.json');
  });

  it('serves the last good first page, marked stale, when JS Journey errors, answers garbage or is unreachable', async () => {
    serveFeed();
    await journey.feed('mansi', null);
    reply = () => ({ status: 503, body: { message: 'maintenance' } });
    expect(await journey.feed('mansi', null)).toEqual({ feed: feed(), stale: true });
    reply = () => ({ status: 200, body: { hello: 'world' } });
    expect(await journey.feed('mansi', null)).toEqual({ feed: feed(), stale: true });
    await config.setJourneyLink('mansi', DOWN);
    expect(await journey.feed('mansi', null)).toEqual({ feed: feed(), stale: true });
    expect(logged).toContain('[journey] mansi: feed HTTP 503 — maintenance (serving the cached copy)');
    expect(logged.some((l) => /^\[journey\] mansi: feed unreachable — .+ \(serving the cached copy\)$/.test(l))).toBe(true);
    // a restarted server still has it (it lives on the SSD, not in memory)
    const restarted = await makeJourney();
    expect(await restarted.feed('mansi', null)).toEqual({ feed: feed(), stale: true });
  });

  it('null when nothing is cached and JS Journey is unreachable; a later page offline is null too', async () => {
    await config.setJourneyLink('mansi', DOWN);
    expect(await journey.feed('mansi', null)).toBeNull();
    expect(logged.at(-1)).toMatch(/^\[journey\] mansi: feed unreachable — .+ \(nothing cached yet\)$/);
    await config.setJourneyLink('mansi', `${stubOrigin}/m/${TOKEN}`);
    serveFeed();
    await journey.feed('mansi', null);
    await config.setJourneyLink('mansi', DOWN);
    expect(await journey.feed('mansi', 'c2')).toBeNull();
    expect(logged.at(-1)).toMatch(/\(later pages are not cached\)$/);
  });

  it('not connected: the cached copy (stale) if there is one, else null — and JS Journey is not called', async () => {
    expect(await journey.feed('rahul', null)).toBeNull();
    serveFeed();
    await journey.feed('mansi', null);
    await config.setJourneyLink('mansi', null);
    const before = seen.length;
    expect(await journey.feed('mansi', null)).toEqual({ feed: feed(), stale: true });
    expect(seen.length).toBe(before);
  });

  it('an unreadable cache is ignored (logged) and replaced by the next good feed', async () => {
    await writeFile(path.join(dir, 'feed-mansi.json'), '{"feed": {"upd');
    await config.setJourneyLink('mansi', DOWN);
    expect(await journey.feed('mansi', null)).toBeNull();
    expect(logged.some((l) => l.startsWith('[journey] mansi: feed-mansi.json is unreadable'))).toBe(true);
    await config.setJourneyLink('mansi', `${stubOrigin}/m/${TOKEN}`);
    serveFeed();
    await journey.feed('mansi', null);
    expect(await onDisk('feed-mansi.json')).toMatchObject({ feed: feed() });
  });

  it('does not rewrite the cache when the feed did not change (every write costs on the exFAT SSD)', async () => {
    serveFeed();
    await journey.feed('mansi', null);
    const file = path.join(dir, 'feed-mansi.json');
    await writeFile(file, (await readFile(file, 'utf8')).replace('"v":1', '"v":1,"marker":true'));
    await journey.feed('mansi', null);
    expect(await readFile(file, 'utf8')).toContain('"marker":true');
    serveFeed(feed({ unreadForStudent: 1 }));
    await journey.feed('mansi', null);
    expect(await readFile(file, 'utf8')).not.toContain('"marker":true');
  });
});

describe('read receipts', () => {
  it('POSTs {ids} to /api/player/feed/read with the token', async () => {
    expect(await journey.enqueueReads('mansi', [M_REPLY, M_NOTE])).toMatchObject({ pending: 0, lastError: null });
    await journey.settled('mansi');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/api/player/feed/read', auth: `Bearer ${TOKEN}` });
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual({ ids: [M_REPLY, M_NOTE] });
    expect((await outboxOnDisk()).reads).toEqual([]);
  });

  it('unreachable: kept, merged idempotently, survive a restart, delivered once on the next flush', async () => {
    await config.setJourneyLink('mansi', DOWN);
    const [a, b, c] = [msgId(11), msgId(12), msgId(13)];
    await journey.enqueueReads('mansi', [a, b]);
    expect((await journey.settled('mansi')).lastError).toMatch(/^unreachable/);
    await journey.enqueueReads('mansi', [b, c]);
    await journey.settled('mansi');
    expect((await outboxOnDisk()).reads.map((r) => r.id)).toEqual([a, b, c]);

    const restarted = await makeJourney();
    await config.setJourneyLink('mansi', `${stubOrigin}/m/${TOKEN}`);
    expect(await restarted.flush('mansi')).toMatchObject({ pending: 0, lastError: null });
    expect(seen.map((s) => [s.url, JSON.parse(s.body) as unknown])).toEqual([['/api/player/feed/read', { ids: [a, b, c] }]]);
    expect(await restarted.flush('mansi')).toMatchObject({ pending: 0, lastError: null });
    expect(seen).toHaveLength(1);
  });

  it('4xx drops them (no endless retries) and keeps the message in lastError', async () => {
    reply = () => ({ status: 422, body: { error: 'Unknown message id' } });
    await journey.enqueueReads('mansi', [msgId(99)]);
    expect(await journey.settled('mansi')).toMatchObject({ pending: 0, lastError: 'HTTP 422 — Unknown message id' });
    expect((await outboxOnDisk()).reads).toEqual([]);
  });

  it('more than 500 queued (a long time offline) go in batches of 500 — JS Journey 400s a bigger list', async () => {
    await config.setJourneyLink('mansi', DOWN);
    await journey.enqueueReads('mansi', Array.from({ length: 500 }, (_, i) => msgId(i)));
    await journey.enqueueReads('mansi', [msgId(500)]);
    await journey.settled('mansi');
    await config.setJourneyLink('mansi', `${stubOrigin}/m/${TOKEN}`);
    expect(await journey.flush('mansi')).toMatchObject({ pending: 0, lastError: null });
    expect(seen.map((s) => (JSON.parse(s.body) as { ids: string[] }).ids.length)).toEqual([500, 1]);
    expect((await outboxOnDisk()).reads).toEqual([]);
  });

  it('marks them read in the cached feed at once, so an offline app open does not show them as new again', async () => {
    serveFeed();
    await journey.feed('mansi', null);
    await config.setJourneyLink('mansi', DOWN);
    await journey.enqueueReads('mansi', [M_REPLY]);
    const served = await journey.feed('mansi', null);
    expect(served?.stale).toBe(true);
    expect(served?.feed.updates[0]?.replies[0]?.readAt).toEqual(expect.any(String));
    expect(served?.feed.notes[0]?.readAt).toBeNull();
    expect(served?.feed.unreadForStudent).toBe(1);
  });

  it('a fresh feed fetched while receipts are still queued shows them read', async () => {
    reply = (req) => (req.url === '/api/player/feed/read' ? { status: 503, body: { error: 'down' } } : { status: 200, body: feed() });
    await journey.enqueueReads('mansi', [M_NOTE]);
    expect((await journey.settled('mansi')).lastError).toBe('HTTP 503 — down');
    const served = await journey.feed('mansi', null);
    expect(served).toMatchObject({ stale: false });
    expect(served?.feed.notes[0]?.readAt).toEqual(expect.any(String));
    expect(served?.feed.unreadForStudent).toBe(1);
  });

  it('delivery marks them read in the cached feed too (a fresh feed cached before delivery may lack them)', async () => {
    reply = (req) => (req.url === '/api/player/feed/read' ? { status: 503, body: { error: 'down' } } : { status: 200, body: feed() });
    await journey.enqueueReads('mansi', [M_REPLY]);
    await journey.settled('mansi');
    // what a fresh feed fetched concurrently with "Got it" leaves behind: the page without the receipt
    await writeFile(path.join(dir, 'feed-mansi.json'), JSON.stringify({ v: 1, feed: feed() }));
    reply = () => ({ status: 200 });
    await journey.flush('mansi');
    expect((await outboxOnDisk()).reads).toEqual([]);
    await config.setJourneyLink('mansi', DOWN);
    const served = await journey.feed('mansi', null);
    expect(served?.feed.updates[0]?.replies[0]?.readAt).toEqual(expect.any(String));
    expect(logged).toContain('[journey] mansi: 1 read receipt(s) delivered');
  });

  it('null for a profile without a JS Journey link (nothing written)', async () => {
    expect(await journey.enqueueReads('rahul', [M_REPLY])).toBeNull();
    expect((await readdir(dir)).filter((f) => f.startsWith('outbox'))).toEqual([]);
  });
});

describe('progress snapshot', () => {
  it('PUTs the snapshot to /api/player/progress with the token', async () => {
    expect(await journey.enqueueProgress('mansi', snapshot(100))).toMatchObject({ pending: 0, lastError: null });
    await journey.settled('mansi');
    expect(seen[0]).toMatchObject({ method: 'PUT', url: '/api/player/progress', auth: `Bearer ${TOKEN}` });
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual(snapshot(100));
    expect((await outboxOnDisk()).progress).toBeNull();
  });

  it('offline: keeps only the newest by takenAt, survives a restart, and delivers it once', async () => {
    await config.setJourneyLink('mansi', DOWN);
    await journey.enqueueProgress('mansi', snapshot(200));
    await journey.enqueueProgress('mansi', snapshot(100, { lecturesDone: 1 })); // older: ignored
    await journey.enqueueProgress('mansi', snapshot(300, { lecturesDone: 13 }));
    await journey.enqueueProgress('mansi', snapshot(250));
    await journey.settled('mansi');
    expect((await outboxOnDisk()).progress).toEqual(snapshot(300, { lecturesDone: 13 }));

    const restarted = await makeJourney();
    await config.setJourneyLink('mansi', `${stubOrigin}/m/${TOKEN}`);
    await restarted.flush('mansi');
    expect(seen.map((s) => [s.method, s.url, (JSON.parse(s.body) as ProgressSnapshot).takenAt])).toEqual([['PUT', '/api/player/progress', 300]]);
    await restarted.flush('mansi');
    expect(seen).toHaveLength(1);
  });

  it('4xx drops it and keeps the message in lastError', async () => {
    reply = () => ({ status: 400, body: { error: 'course must be react-2023' } });
    await journey.enqueueProgress('mansi', snapshot(1));
    expect(await journey.settled('mansi')).toMatchObject({ pending: 0, lastError: 'HTTP 400 — course must be react-2023' });
    expect((await outboxOnDisk()).progress).toBeNull();
  });

  it('null for a profile without a JS Journey link', async () => {
    expect(await journey.enqueueProgress('rahul', snapshot(1))).toBeNull();
  });
});

describe('one outbox, one cadence', () => {
  it('a flush sends her updates (oldest first), then read receipts, then the snapshot', async () => {
    await config.setJourneyLink('mansi', DOWN);
    await journey.enqueueProgress('mansi', snapshot(5));
    await journey.enqueueReads('mansi', [msgId(11)]);
    await journey.enqueue('mansi', session('s1'));
    await journey.enqueue('mansi', session('s2'));
    await journey.settled('mansi');
    await config.setJourneyLink('mansi', `${stubOrigin}/m/${TOKEN}`);
    expect(await journey.flush('mansi')).toMatchObject({ pending: 0, lastError: null });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'POST /api/player/sessions',
      'POST /api/player/sessions',
      'POST /api/player/feed/read',
      'PUT /api/player/progress',
    ]);
  });

  // Review 2026-10-01: a 5xx can be about one row (a JS Journey insert error on that session); stopping
  // the whole flush there stalled "Got it" and the coach's stats until that session cleared.
  it('an HTTP 5xx on her update holds back only her updates: receipts and the snapshot still go', async () => {
    reply = (req) => (req.url === '/api/player/sessions' ? { status: 503, body: { error: 'insert failed' } } : { status: 200 });
    await config.setJourneyLink('mansi', DOWN);
    await journey.enqueue('mansi', session('s1'));
    await journey.enqueue('mansi', session('s2'));
    await journey.enqueueReads('mansi', [msgId(11)]);
    await journey.enqueueProgress('mansi', snapshot(5));
    await journey.settled('mansi');
    await config.setJourneyLink('mansi', `${stubOrigin}/m/${TOKEN}`);
    expect(await journey.flush('mansi')).toMatchObject({ pending: 2, lastError: 'HTTP 503 — insert failed' });
    expect(seen.map((s) => s.url)).toEqual(['/api/player/sessions', '/api/player/feed/read', '/api/player/progress']);
    const left = await outboxOnDisk();
    expect([left.reads, left.progress]).toEqual([[], null]);
  });

  it('a network error stops the flush: the rest would fail the same way and waits for the next one', async () => {
    const seenHere: string[] = [];
    const flaky = http.createServer((req, res) => {
      seenHere.push(req.url ?? '');
      if (req.url === '/api/player/sessions') {
        req.socket.destroy(); // the connection dies: fetch rejects (no HTTP status)
        return;
      }
      res.writeHead(200).end('{}');
    });
    await new Promise<void>((r) => flaky.listen(0, '127.0.0.1', r));
    await config.setJourneyLink('mansi', DOWN);
    await journey.enqueue('mansi', session('s1'));
    await journey.enqueueReads('mansi', [msgId(11)]);
    await journey.settled('mansi');
    await config.setJourneyLink('mansi', `http://127.0.0.1:${(flaky.address() as AddressInfo).port}/m/${TOKEN}`);
    const state = await journey.flush('mansi');
    expect(state.pending).toBe(1);
    expect(state.lastError).toMatch(/^unreachable/);
    expect(seenHere).toEqual(['/api/player/sessions']);
    expect((await outboxOnDisk()).reads.map((r) => r.id)).toEqual([msgId(11)]);
    flaky.closeAllConnections();
    await new Promise<void>((r) => flaky.close(() => r()));
  });

  it('flushAll delivers queued receipts + snapshot (start-up, every 5 min, quit)', async () => {
    await config.setJourneyLink('mansi', DOWN);
    await journey.enqueueReads('mansi', [msgId(11)]);
    await journey.enqueueProgress('mansi', snapshot(9));
    await journey.settled('mansi');
    await config.setJourneyLink('mansi', `${stubOrigin}/m/${TOKEN}`);
    await journey.flushAll(2000);
    expect(seen.map((s) => s.url)).toEqual(['/api/player/feed/read', '/api/player/progress']);
  });

  it('still reads a v1 outbox file (sessions only)', async () => {
    await writeFile(path.join(dir, 'outbox-mansi.json'), JSON.stringify({ v: 1, items: [session('old')], lastError: 'HTTP 503 — down' }));
    expect(await journey.settled('mansi')).toMatchObject({ pending: 1, lastError: 'HTTP 503 — down' });
    expect(await journey.flush('mansi')).toMatchObject({ pending: 0, lastError: null });
    expect(seen.map((s) => s.url)).toEqual(['/api/player/sessions']);
  });
});

// ---- v3: the outbox never drops an update (docs/spec-v3-study-timer.md A2) ----------------------
// 2026-10-05: a 4xx'd update was deleted for good, and an update made while not connected was never
// queued at all — Mansi's sign-off vanished on both paths.

describe('v3 outbox: every update reaches Rahul or stays visible', () => {
  const COURSE_404 = { status: 400, body: { error: 'course "react-course" is not a JS Journey course (known: js-course, react-2023)' } };

  it("loads her Mac's v2 outbox file unchanged (items + reads + progress + lastError) and delivers it", async () => {
    const v2 = { v: 2, items: [session('a'), session('b')], reads: [{ id: msgId(7), at: '2026-10-05T08:00:00.000Z' }], progress: snapshot(3), lastError: 'HTTP 400 — unknown course' };
    await writeFile(path.join(dir, 'outbox-mansi.json'), JSON.stringify(v2));
    const before = await journey.outbox('mansi');
    expect(before).toMatchObject({ pending: 2, lastError: 'HTTP 400 — unknown course' });
    expect(before.updates.map((u) => [u.id, u.state])).toEqual([
      ['a', 'queued'],
      ['b', 'queued'],
    ]);
    expect(await journey.flush('mansi')).toMatchObject({ pending: 0, lastError: null });
    expect(seen.map((r) => r.url)).toEqual(['/api/player/sessions', '/api/player/sessions', '/api/player/feed/read', '/api/player/progress']);
    const disk = await outboxOnDisk();
    expect(disk).toMatchObject({ v: 3, items: [], rejected: [], reads: [], progress: null, lastError: null });
    expect(disk.delivered.map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('a rejected update is re-queued on demand (Try again) and delivered; receipts say when', async () => {
    reply = () => COURSE_404;
    await journey.enqueue('mansi', session('s1'));
    expect((await journey.settled('mansi')).updates).toMatchObject([{ id: 's1', state: 'rejected' }]);
    reply = () => ({ status: 201, body: { status: 'created' } });
    const t0 = Date.now();
    expect(await journey.retry('mansi')).toMatchObject({ pending: 1, updates: [{ id: 's1', state: 'queued', error: null }] });
    const state = await journey.settled('mansi');
    expect(state).toMatchObject({ pending: 0, lastError: null, updates: [{ id: 's1', state: 'delivered', error: null }] });
    expect(Date.parse(state.updates[0]?.at ?? '')).toBeGreaterThanOrEqual(t0 - 5);
    expect('session' in (state.updates[0] ?? {})).toBe(false); // a receipt, not her update again
    expect(logged).toContain('[journey] mansi: 1 rejected update(s) re-queued (try again)');
  });

  it('retry with ids re-queues only those; unknown ids are ignored', async () => {
    reply = () => COURSE_404;
    await journey.enqueue('mansi', session('s1'));
    await journey.enqueue('mansi', session('s2'));
    await journey.settled('mansi');
    reply = () => ({ status: 503 }); // keep re-queued ones visible as queued
    expect((await journey.retry('mansi', ['s2', 'nope'])).updates.map((u) => [u.id, u.state]).sort()).toEqual([
      ['s1', 'rejected'],
      ['s2', 'queued'],
    ]);
  });

  it('server start re-queues every rejected update once, then flushes (a fixed course id makes them go through)', async () => {
    reply = () => COURSE_404;
    await journey.enqueue('mansi', session('s1'));
    await journey.settled('mansi');
    reply = () => ({ status: 201 });
    const restarted = await makeJourney();
    await restarted.start();
    restarted.stop();
    expect(await restarted.settled('mansi')).toMatchObject({ pending: 0, lastError: null, updates: [{ id: 's1', state: 'delivered' }] });
    expect(logged).toContain('[journey] mansi: 1 rejected update(s) re-queued (server start)');
  });

  it('sends every update under THIS copy\'s course id, even one queued under an older (guessed) id', async () => {
    const guessed = session('old', { course: 'react-course', progress: snapshot(4, { course: 'react-course' }) });
    await writeFile(path.join(dir, 'outbox-mansi.json'), JSON.stringify({ v: 3, items: [], rejected: [{ session: guessed, error: 'HTTP 400 — course "react-course" is not a JS Journey course', at: '2026-10-05T08:40:00.000Z' }], delivered: [], reads: [], progress: snapshot(5, { course: 'react-course' }), lastError: null }));
    reply = () => ({ status: 201 });
    await journey.retry('mansi');
    await journey.settled('mansi');
    const sent = seen.map((r) => JSON.parse(r.body) as { course: string; progress?: { course: string } | null });
    expect(sent.map((b) => b.course)).toEqual(['react-2023', 'react-2023']);
    expect(sent[0]?.progress?.course).toBe('react-2023');
    expect(logged).toContain('[journey] mansi: session old was queued for course "react-course" — sent as "react-2023"');
  });

  it('re-posting a rejected id (her edited note) moves it back to the queue — one entry per id', async () => {
    reply = () => COURSE_404;
    await journey.enqueue('mansi', session('s1', { note: 'first' }));
    await journey.settled('mansi');
    reply = () => ({ status: 503 });
    const state = await journey.enqueue('mansi', session('s1', { note: 'edited' }));
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({ id: 's1', state: 'queued' });
    expect(state.updates[0]?.state === 'queued' && state.updates[0].session.note).toBe('edited');
    expect((await outboxOnDisk()).rejected).toEqual([]);
  });

  // Review 2026-10-05: JS Journey keeps ONE row per update id and answers a re-post with 200 "duplicate",
  // storing nothing. A CHANGED copy of a delivered update (a 2nd window's sign-off of the same session; a
  // card's "Try again" after a restart already delivered the old body) was queued and "delivered" — the
  // card said "Sent to Rahul ✓ · note included" while her new note was dropped.
  it('a changed copy of an update JS Journey already has is refused, never queued to be ignored; the same one again is a no-op', async () => {
    reply = () => ({ status: 201, body: { status: 'created' } });
    await journey.enqueue('mansi', session('s1', { note: 'first note' }));
    await journey.settled('mansi');
    // the same words again (a retried POST, a migration run twice) — its snapshot is newer, that is all
    const again = await journey.enqueue('mansi', session('s1', { note: 'first note', progress: snapshot(Date.parse('2026-10-05T11:00:00.000Z')) }));
    expect(again).toMatchObject({ pending: 0, updates: [{ id: 's1', state: 'delivered' }] });
    const changed = journey.enqueue('mansi', session('s1', { note: 'second note', minutes: 77 }));
    await expect(changed).rejects.toBeInstanceOf(AlreadyDelivered);
    await expect(changed).rejects.toThrow('This update already reached Rahul — what you changed can’t be added to it. Send it as a Note to Rahul… instead.');
    await journey.settled('mansi');
    expect(seen.filter((r) => r.url === '/api/player/sessions')).toHaveLength(1);
    expect(await outboxOnDisk()).toMatchObject({ items: [], rejected: [] });
    expect(logged).toContain('[journey] mansi: session s1 already reached JS Journey — a changed copy was refused');
  });

  it('JS Journey answering "duplicate" is logged: it stored nothing from that body', async () => {
    reply = () => ({ status: 200, body: { status: 'duplicate', id: 's1', progress: 'stale' } });
    await journey.enqueue('mansi', session('s1'));
    expect((await journey.settled('mansi')).updates).toMatchObject([{ id: 's1', state: 'delivered' }]);
    expect(logged).toContain('[journey] mansi: session s1 was already on JS Journey (answered duplicate) — it kept the copy it had');
  });

  it('a "duplicate" answer keeps the receipt of the copy JS Journey has — a later post is judged against THAT one', async () => {
    reply = () => ({ status: 201, body: { status: 'created' } });
    await journey.enqueue('mansi', session('s1', { note: 'first note' }));
    await journey.settled('mansi');
    // a changed copy that got queued anyway (re-posted while the first was in flight), then delivered
    const disk = await outboxOnDisk();
    await writeFile(path.join(dir, 'outbox-mansi.json'), JSON.stringify({ ...disk, items: [session('s1', { note: 'second note' })] }));
    reply = () => ({ status: 200, body: { status: 'duplicate', id: 's1' } });
    await journey.flush('mansi');
    await expect(journey.enqueue('mansi', session('s1', { note: 'second note' }))).rejects.toBeInstanceOf(AlreadyDelivered);
    expect((await journey.enqueue('mansi', session('s1', { note: 'first note' }))).pending).toBe(0);
  });

  it('read receipts and snapshots are still dropped on 4xx (they carry no words of hers)', async () => {
    reply = () => ({ status: 400, body: { error: 'bad ids' } });
    await journey.enqueueReads('mansi', [msgId(3)]);
    await journey.enqueueProgress('mansi', snapshot(9));
    expect(await journey.settled('mansi')).toMatchObject({ pending: 0, updates: [] });
    expect(await outboxOnDisk()).toMatchObject({ reads: [], progress: null, rejected: [] });
  });

  it('not connected: updates wait in the outbox and go out as soon as she connects', async () => {
    await config.setJourneyLink('mansi', null);
    expect(await journey.enqueue('mansi', session('s1'))).toMatchObject({ pending: 1 });
    expect(await journey.settled('mansi')).toMatchObject({ pending: 1, lastError: null });
    expect(seen).toEqual([]);
    await config.setJourneyLink('mansi', `${stubOrigin}/m/${TOKEN}`);
    reply = () => ({ status: 201 });
    expect(await journey.flush('mansi')).toMatchObject({ pending: 0, updates: [{ id: 's1', state: 'delivered' }] });
  });

  it('keeps the last 50 delivery receipts (newest), all queued and all rejected', async () => {
    const delivered = Array.from({ length: 60 }, (_, i) => ({ id: `d${i}`, at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString() }));
    await writeFile(path.join(dir, 'outbox-mansi.json'), JSON.stringify({ v: 3, items: [], rejected: [], delivered, reads: [], progress: null, lastError: null }));
    reply = () => ({ status: 201 });
    await journey.enqueue('mansi', session('new'));
    const state = await journey.settled('mansi');
    const ids = state.updates.map((u) => u.id);
    expect(ids).toHaveLength(50);
    expect(ids[0]).toBe('new');
    expect(ids.at(-1)).toBe('d11');
    expect((await outboxOnDisk()).delivered).toHaveLength(50);
  });

  it('lists updates newest first: queued (at = endedAt), rejected (at = when refused), delivered receipts', async () => {
    await writeFile(
      path.join(dir, 'outbox-mansi.json'),
      JSON.stringify({
        v: 3,
        items: [session('q', { endedAt: '2026-10-05T12:00:00.000Z' })],
        rejected: [{ session: session('r'), error: 'HTTP 400 — nope', at: '2026-10-05T11:00:00.000Z' }],
        delivered: [{ id: 'd', at: '2026-10-05T13:00:00.000Z' }],
        reads: [],
        progress: null,
        lastError: null,
      }),
    );
    await config.setJourneyLink('mansi', null); // nothing is sent while we look
    expect((await journey.outbox('mansi')).updates).toEqual([
      { id: 'd', state: 'delivered', at: '2026-10-05T13:00:00.000Z', error: null },
      { id: 'q', state: 'queued', at: '2026-10-05T12:00:00.000Z', error: null, session: session('q', { endedAt: '2026-10-05T12:00:00.000Z' }) },
      { id: 'r', state: 'rejected', at: '2026-10-05T11:00:00.000Z', error: 'HTTP 400 — nope', session: session('r') },
    ]);
  });

  it('an outbox whose rejected list is malformed is moved aside, never half-read', async () => {
    await writeFile(path.join(dir, 'outbox-mansi.json'), JSON.stringify({ v: 3, items: [], rejected: [{ nope: 1 }], delivered: [], reads: [], progress: null, lastError: null }));
    expect(await journey.outbox('mansi')).toMatchObject({ pending: 0, updates: [] });
    expect(await readdir(dir)).toContain('outbox-mansi.json.corrupt');
  });

  it('outbox(profile, waitMs) answers once the delivery in flight settled (bounded)', async () => {
    const slow = http.createServer((req, res) => {
      req.resume();
      setTimeout(() => {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end('{}');
      }, 300);
    });
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
    await config.setJourneyLink('mansi', `http://127.0.0.1:${(slow.address() as AddressInfo).port}/m/${TOKEN}`);
    await journey.enqueue('mansi', session('s1'));
    expect((await journey.outbox('mansi', 2000)).updates).toMatchObject([{ id: 's1', state: 'delivered' }]);
    await journey.enqueue('mansi', session('s2'));
    const t0 = Date.now();
    expect((await journey.outbox('mansi', 50)).updates[0]).toMatchObject({ id: 's2', state: 'queued' });
    expect(Date.now() - t0).toBeLessThan(250);
    await journey.settled('mansi');
    slow.closeAllConnections();
    await new Promise<void>((r) => slow.close(() => r()));
  });
});

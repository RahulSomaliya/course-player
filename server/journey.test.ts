import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { JourneySession, JourneyStatus } from '../shared/types.ts';
import { ConfigStore } from './config.ts';
import { Journey, isJourneyStatus, parseStudentLink, validateSession } from './journey.ts';
import { makeTempDir, memoryLog, session, startStubJourney, type SeenRequest, type StubJourney } from './test-helpers.ts';

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
};

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
  it('validateSession accepts a JourneySession and names the bad field otherwise', () => {
    expect(validateSession(session('s1'), 'react-2023')).toBeNull();
    expect(validateSession(session('s1', { minutes: 0 }), 'react-2023')).toMatch(/minutes/);
    expect(validateSession(session('s1', { course: 'vue' }), 'react-2023')).toMatch(/course/);
    expect(validateSession(session('s1', { studyDate: '5 Oct' }), 'react-2023')).toMatch(/studyDate/);
    expect(validateSession(session('s1', { mood: '🤖' }), 'react-2023')).toMatch(/mood/);
    expect(validateSession(session('s1', { lecturesCompleted: [{ section: 1, lecture: 1 } as never] }), 'react-2023')).toMatch(/lecturesCompleted/);
    expect(validateSession(null, 'react-2023')).not.toBeNull();
  });

  it('isJourneyStatus checks the shape', () => {
    expect(isJourneyStatus(status)).toBe(true);
    expect(isJourneyStatus({ ...status, pace: 'fast' })).toBe(false);
    expect(isJourneyStatus({ ...status, goal: { title: 'x' } })).toBe(false);
  });

  it('isJourneyStatus checks planBreak (Mansi\'s 1–15 Nov Diwali break); an older JS Journey omits it', () => {
    const diwali = { label: 'Diwali break', start: '2026-11-01', end: '2026-11-15' };
    expect(isJourneyStatus({ ...status, planBreak: diwali })).toBe(true);
    const { planBreak: _omit, ...old } = status;
    expect(isJourneyStatus(old)).toBe(true);
    expect(isJourneyStatus({ ...status, planBreak: 'Diwali' })).toBe(false);
    expect(isJourneyStatus({ ...status, planBreak: { ...diwali, label: 7 } })).toBe(false);
    expect(isJourneyStatus({ ...status, planBreak: { ...diwali, start: '1 Nov' } })).toBe(false);
    expect(isJourneyStatus({ ...status, planBreak: { ...diwali, end: undefined } })).toBe(false);
    expect(isJourneyStatus({ ...status, planBreak: { ...diwali, start: '2026-11-16' } })).toBe(false); // ends before it starts
  });
});

describe('outbox', () => {
  it('2xx: sends with the Bearer token and removes the session', async () => {
    reply = () => ({ status: 201, body: { ok: true } });
    expect(await journey.enqueue('mansi', session('s1'))).toEqual({ pending: 0, lastError: null });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/api/player/sessions', auth: `Bearer ${TOKEN}` });
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual(session('s1'));
    expect(await journey.outbox('mansi')).toEqual({ pending: 0, lastError: null });
    expect(logged).toContain('[journey] mansi: sent 1, 0 pending');
  });

  it('4xx: removes the session too (no endless retries) and keeps the message in lastError', async () => {
    reply = () => ({ status: 422, body: { error: 'Session overlaps another one' } });
    expect(await journey.enqueue('mansi', session('s1'))).toEqual({
      pending: 0,
      lastError: 'HTTP 422 — Session overlaps another one',
    });
    expect(logged.some((l) => l.startsWith('[journey] mansi: HTTP 422 — Session overlaps another one'))).toBe(true);
    // a later success clears it
    reply = () => ({ status: 200 });
    expect(await journey.enqueue('mansi', session('s2'))).toEqual({ pending: 0, lastError: null });
  });

  it('5xx: keeps the session, survives a restart, and delivers it on the next flush', async () => {
    reply = () => ({ status: 503, body: { message: 'maintenance' } });
    expect(await journey.enqueue('mansi', session('s1'))).toEqual({ pending: 1, lastError: 'HTTP 503 — maintenance' });
    expect(await journey.enqueue('mansi', session('s2'))).toEqual({ pending: 2, lastError: 'HTTP 503 — maintenance' });
    // the flush stops at the first transient failure instead of hammering a down server
    expect(seen.filter((s) => s.method === 'POST')).toHaveLength(2);

    const restarted = await makeJourney();
    reply = () => ({ status: 200 });
    expect(await restarted.flush('mansi')).toEqual({ pending: 0, lastError: null });
    expect(seen.slice(-2).map((s) => (JSON.parse(s.body) as JourneySession).id)).toEqual(['s1', 's2']);
  });

  it('an unreachable JS Journey keeps the session pending', async () => {
    await config.setJourneyLink('mansi', `http://127.0.0.1:9/m/${TOKEN}`);
    const state = await journey.enqueue('mansi', session('s1'));
    expect(state?.pending).toBe(1);
    expect(state?.lastError).toMatch(/^unreachable/);
  });

  it('re-posting a pending session id replaces it instead of duplicating it', async () => {
    reply = () => ({ status: 500 });
    await journey.enqueue('mansi', session('s1', { note: 'first' }));
    expect((await journey.enqueue('mansi', session('s1', { note: 'second' })))?.pending).toBe(1);
  });

  it('refuses sessions for a profile without a JS Journey link and writes nothing', async () => {
    expect(await journey.enqueue('rahul', session('s1'))).toBeNull();
    expect((await readdir(dir)).filter((f) => f.startsWith('outbox'))).toEqual([]);
  });

  it('moves an unreadable outbox aside instead of crashing or silently dropping it', async () => {
    await writeFile(path.join(dir, 'outbox-mansi.json'), '{"items": [tru');
    expect(await journey.outbox('mansi')).toEqual({ pending: 0, lastError: null });
    expect(await readdir(dir)).toContain('outbox-mansi.json.corrupt');
    expect(logged).toContain('[journey] mansi: outbox-mansi.json is unreadable — moved aside to outbox-mansi.json.corrupt');
  });

  it('a flush whose deadline already passed sends nothing and keeps lastError', async () => {
    reply = () => ({ status: 503, body: { message: 'down' } });
    await journey.enqueue('mansi', session('s1'));
    const before = seen.length;
    expect(await journey.flush('mansi', Date.now() - 1)).toEqual({ pending: 1, lastError: 'HTTP 503 — down' });
    expect(seen.length).toBe(before);
  });

  it('flushAll respects its deadline', async () => {
    reply = () => ({ status: 500 });
    await journey.enqueue('mansi', session('s1'));
    const slow = http.createServer(() => {
      /* never answers */
    });
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
    await config.setJourneyLink('mansi', `http://127.0.0.1:${(slow.address() as AddressInfo).port}/m/${TOKEN}`);
    const t0 = Date.now();
    await journey.flushAll(300);
    expect(Date.now() - t0).toBeLessThan(900);
    expect((await journey.outbox('mansi')).pending).toBe(1);
    slow.closeAllConnections();
    await new Promise<void>((r) => slow.close(() => r()));
  });
});

describe('status proxy + link check', () => {
  it('returns the JourneyStatus for a connected profile, asking for this course with the token', async () => {
    reply = () => ({ status: 200, body: status });
    expect(await journey.status('mansi')).toEqual(status);
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/api/player/status?course=react-2023', auth: `Bearer ${TOKEN}` });
  });

  it('returns null when not connected, on non-2xx, or for an unexpected body', async () => {
    expect(await journey.status('rahul')).toBeNull();
    reply = () => ({ status: 500, body: { error: 'boom' } });
    expect(await journey.status('mansi')).toBeNull();
    reply = () => ({ status: 200, body: { hello: 'world' } });
    expect(await journey.status('mansi')).toBeNull();
    reply = () => ({ status: 204 });
    expect(await journey.status('mansi')).toBeNull();
  });

  it('checkLink: 400 for a malformed link, 502 when JS Journey rejects it, ok on 2xx', async () => {
    expect(await journey.checkLink('not a link')).toMatchObject({ ok: false, status: 400 });
    reply = () => ({ status: 401, body: { error: 'Unknown token' } });
    expect(await journey.checkLink(`${stubOrigin}/m/${TOKEN}`)).toMatchObject({ ok: false, status: 502 });
    reply = () => ({ status: 200, body: status });
    expect(await journey.checkLink(`${stubOrigin}/m/${TOKEN}`)).toEqual({ ok: true, link: `${stubOrigin}/m/${TOKEN}` });
    expect(await journey.checkLink(`http://127.0.0.1:9/m/${TOKEN}`)).toMatchObject({ ok: false, status: 502 });
  });
});

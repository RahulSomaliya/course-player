import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BootPayload, JourneyFeed, JourneyProblem, OutboxState, Profile, ProgressSnapshot, ProgressState } from '../shared/types.ts';
import { createCourseServer, type CourseServer } from './app.ts';
import {
  feed,
  jsonBody,
  M_NOTE,
  M_REPLY,
  makeTempDir,
  memoryLog,
  mp4,
  msgId,
  progress,
  request,
  session,
  snapshot,
  startStubJourney,
  writeTree,
  type StubJourney,
} from './test-helpers.ts';

const TOKEN = 'stu_tok_app_test_123';

let tmp = '';
let root = '';
let dataDir = '';
let webDir = '';
let cleanup: () => Promise<void> = async () => {};
let app: CourseServer;
let port = 0;
let exit: ReturnType<typeof vi.fn<(code: number) => void>>;
let logged: string[] = [];
let stub: StubJourney;

beforeAll(async () => {
  stub = await startStubJourney();
});
afterAll(() => stub.close());

async function boot(opts: { web?: boolean } = {}): Promise<void> {
  const { log, lines } = memoryLog();
  logged = lines;
  exit = vi.fn<(code: number) => void>();
  app = await createCourseServer({
    root,
    dataDir,
    webDir: opts.web === false ? path.join(tmp, 'no-web-here') : webDir,
    version: 'test-1',
    log,
    exit,
    journeyTimeoutMs: 1000,
    quitFlushMs: 500,
  });
  port = await app.listen(0);
}

beforeEach(async () => {
  ({ dir: tmp, cleanup } = await makeTempDir('app'));
  root = path.join(tmp, 'React 2023');
  dataDir = path.join(tmp, 'data');
  webDir = path.join(tmp, 'web');
  stub.seen.length = 0;
  stub.setReply(() => ({ status: 200, body: {} }));
  await writeTree(root, {
    '01 Welcome/01 Intro.mp4': mp4({ duration: 60_000 }),
    '01 Welcome/01.1 Slides.pdf': '%PDF-1.4',
    '02 Part 1 - Basics (2 Projects)/01 Part Intro.mp4': mp4({ duration: 30_000 }),
  });
  await writeTree(webDir, {
    'index.html': '<!doctype html><title>Course Player</title>',
    'assets/app-abc123.js': 'console.log(1)',
    'assets/app-abc123.css': 'body{}',
  });
  await writeTree(dataDir, {
    'config.json': JSON.stringify({
      title: 'The Ultimate React Course',
      subtitle: 'Jonas Schmedtmann · 2023',
      profiles: [
        { id: 'rahul', name: 'Rahul' },
        { id: 'mansi', name: 'Mansi' },
      ],
    }),
  });
  await boot();
});

afterEach(async () => {
  // let the background scan finish writing durations.json before the temp dir goes away
  await app.course();
  await app.stop();
  expect(logged.join('\n')).not.toContain(TOKEN);
  await cleanup();
});

describe('single origin + CSRF', () => {
  it('answers /api/ping on localhost:<port>', async () => {
    const res = await request(port, 'GET', '/api/ping');
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ app: 'course-player', version: 'test-1' });
  });

  it('308s any other Host to http://localhost:<port><url>', async () => {
    const res = await request(port, 'GET', '/api/ping?x=1', { host: `127.0.0.1:${port}` });
    expect(res.status).toBe(308);
    expect(res.headers.location).toBe(`http://localhost:${port}/api/ping?x=1`);
    const other = await request(port, 'GET', '/', { host: 'evil.example' });
    expect(other.status).toBe(308);
    expect(other.headers.location).toBe(`http://localhost:${port}/`);
  });

  it('403s a non-GET /api call without x-course-player: 1', async () => {
    const quit = await request(port, 'POST', '/api/quit');
    expect(quit.status).toBe(403);
    const put = await request(port, 'PUT', '/api/progress/rahul', { body: JSON.stringify(progress(1)) });
    expect(put.status).toBe(403);
    const wrong = await request(port, 'PUT', '/api/progress/rahul', {
      headers: { 'x-course-player': 'yes' },
      body: JSON.stringify(progress(1)),
    });
    expect(wrong.status).toBe(403);
    expect(exit).not.toHaveBeenCalled();
    const ok = await request(port, 'PUT', '/api/progress/rahul', jsonBody(progress(1)));
    expect(ok.status).toBe(200);
  });

  it('404s unknown API routes and 405s wrong methods', async () => {
    expect((await request(port, 'GET', '/api/nope')).status).toBe(404);
    expect((await request(port, 'POST', '/api/ping', jsonBody({}))).status).toBe(405);
  });
});

describe('boot + progress', () => {
  it('GET /api/boot returns the scanned course, profiles and version', async () => {
    const res = await request(port, 'GET', '/api/boot');
    expect(res.status).toBe(200);
    const body = res.json() as BootPayload;
    expect(body.version).toBe('test-1');
    expect(body.course.id).toBe('react-2023');
    expect(body.course.title).toBe('The Ultimate React Course');
    expect(body.course.subtitle).toBe('Jonas Schmedtmann · 2023');
    expect(body.course.totals).toEqual({ lectures: 2, videos: 2, duration: 90 });
    expect(body.course.sections[1]?.part).toEqual({ number: 1, projects: 2 });
    expect(body.profiles).toEqual([
      { id: 'rahul', name: 'Rahul', journeyConnected: false },
      { id: 'mansi', name: 'Mansi', journeyConnected: false },
    ]);
    // no .player/course.json and no courseId in config.json here: guessed, and said so
    expect(body.courseIdFrom).toBe('folder');
    expect(body.folderCourseId).toBe('react-2023');
    expect(logged.some((l) => l.startsWith('[scan] WARNING: course id "react-2023" was guessed from the folder name'))).toBe(true);
  });

  // 2026-10-05: her copy's folder was not "React 2023" → id "react-course" → JS Journey 404'd her update.
  it('v3: the course id is pinned by <course>/.player/course.json, whatever the folder is called', async () => {
    await app.course();
    await app.stop();
    const renamed = path.join(tmp, 'React Course');
    await writeTree(renamed, { '01 Welcome/01 Intro.mp4': mp4({ duration: 60_000 }), '.player/course.json': JSON.stringify({ id: 'react-2023' }) });
    root = renamed;
    await boot();
    const body = (await request(port, 'GET', '/api/boot')).json() as BootPayload;
    expect(body.course.id).toBe('react-2023');
    expect(body.courseIdFrom).toBe('course.json');
    expect(body.folderCourseId).toBe('react-course');
    expect(logged.some((l) => l.includes('WARNING'))).toBe(false);
    // sessions are validated against the pinned id
    expect((await request(port, 'POST', '/api/journey/mansi/sessions', jsonBody(session('s1')))).status).toBe(202);
    const wrong = await request(port, 'POST', '/api/journey/mansi/sessions', jsonBody(session('s2', { course: 'react-course' })));
    expect(wrong.status).toBe(400);
    expect((wrong.json() as { error: string }).error).toBe('course must be "react-2023"');
  });

  it('progress: 204 when none, PUT keeps the larger updatedAt, GET returns it', async () => {
    expect((await request(port, 'GET', '/api/progress/rahul')).status).toBe(204);
    const first = await request(port, 'PUT', '/api/progress/rahul', jsonBody(progress(200)));
    expect(first.status).toBe(200);
    expect(first.json()).toEqual(progress(200));
    const older = await request(port, 'PUT', '/api/progress/rahul', jsonBody(progress(100, { days: {} })));
    expect(older.json()).toEqual(progress(200));
    const got = await request(port, 'GET', '/api/progress/rahul');
    expect(got.json()).toEqual(progress(200));
    const onDisk = JSON.parse(await readFile(path.join(dataDir, 'progress-rahul.json'), 'utf8')) as ProgressState;
    expect(onDisk.updatedAt).toBe(200);
  });

  it('progress: 400 for an invalid body, 404 for an unknown profile, 413 for a huge body', async () => {
    const bad = await request(port, 'PUT', '/api/progress/rahul', jsonBody({ v: 1 }));
    expect(bad.status).toBe(400);
    expect((bad.json() as { error: string }).error).toMatch(/updatedAt/);
    const notJson = await request(port, 'PUT', '/api/progress/rahul', { headers: { 'x-course-player': '1' }, body: '{nope' });
    expect(notJson.status).toBe(400);
    expect((await request(port, 'GET', '/api/progress/someone')).status).toBe(404);
    expect((await request(port, 'GET', '/api/progress/..%2Fconfig')).status).toBe(404);
    const huge = await request(port, 'PUT', '/api/progress/rahul', {
      headers: { 'x-course-player': '1' },
      body: 'x'.repeat(3 * 1024 * 1024),
    });
    expect(huge.status).toBe(413);
  });
});

describe('JS Journey routes', () => {
  const link = () => `${stub.origin}/m/${TOKEN}`;

  it('connects a profile after JS Journey accepts the link, never exposing the token', async () => {
    const res = await request(port, 'PUT', '/api/profiles/mansi/journey', jsonBody({ link: link() }));
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ id: 'mansi', name: 'Mansi', journeyConnected: true } satisfies Profile);
    expect(stub.seen[0]).toMatchObject({ url: '/api/player/status?course=react-2023', auth: `Bearer ${TOKEN}` });
    const config = await readFile(path.join(dataDir, 'config.json'), 'utf8');
    expect(config).toContain(TOKEN);
    const bootRes = await request(port, 'GET', '/api/boot');
    expect(bootRes.text).not.toContain(TOKEN);
    expect((bootRes.json() as BootPayload).profiles[1]?.journeyConnected).toBe(true);

    const del = await request(port, 'DELETE', '/api/profiles/mansi/journey', { headers: { 'x-course-player': '1' } });
    expect(del.status).toBe(200);
    expect(del.json()).toEqual({ id: 'mansi', name: 'Mansi', journeyConnected: false });
    expect(await readFile(path.join(dataDir, 'config.json'), 'utf8')).not.toContain(TOKEN);
  });

  it('400s a malformed link and 502s a link JS Journey rejects (nothing saved)', async () => {
    const bad = await request(port, 'PUT', '/api/profiles/mansi/journey', jsonBody({ link: 'https://example.com/hello' }));
    expect(bad.status).toBe(400);
    stub.setReply(() => ({ status: 401, body: { error: 'Unknown token' } }));
    const rejected = await request(port, 'PUT', '/api/profiles/mansi/journey', jsonBody({ link: link() }));
    expect(rejected.status).toBe(502);
    expect((rejected.json() as { error: string }).error).toMatch(/401/);
    expect(await readFile(path.join(dataDir, 'config.json'), 'utf8')).not.toContain(TOKEN);
  });

  it('status is 204 when not connected; v3: sessions are ACCEPTED when not connected and go out on connect', async () => {
    expect((await request(port, 'GET', '/api/journey/mansi/status')).status).toBe(204);
    const res = await request(port, 'POST', '/api/journey/mansi/sessions', jsonBody(session('s1')));
    expect(res.status).toBe(202);
    expect(res.json()).toMatchObject({ pending: 1, lastError: null, updates: [{ id: 's1', state: 'queued' }] });
    expect(stub.seen).toEqual([]);
    stub.setReply(() => ({ status: 201, body: {} }));
    expect((await request(port, 'PUT', '/api/profiles/mansi/journey', jsonBody({ link: link() }))).status).toBe(200);
    expect(await app.journey.settled('mansi')).toMatchObject({ pending: 0, updates: [{ id: 's1', state: 'delivered' }] });
    expect(stub.seen.map((r) => r.url)).toEqual(['/api/player/status?course=react-2023', '/api/player/sessions']);
  });

  it('v3: status answers 409 JourneyProblem when JS Journey does not know the course (not a silent 204)', async () => {
    await request(port, 'PUT', '/api/profiles/mansi/journey', jsonBody({ link: link() }));
    stub.setReply(() => ({ status: 404, body: { error: 'unknown course "react-2023"' } }));
    const res = await request(port, 'GET', '/api/journey/mansi/status');
    expect(res.status).toBe(409);
    expect(res.json()).toEqual({
      error: "JS Journey doesn't know the course 'react-2023' — this copy's course id is wrong; ask Rahul.",
      problem: 'unknown-course',
      courseId: 'react-2023',
    } satisfies JourneyProblem);
  });

  it('v3: connect refuses a good link with 409 when JS Journey does not know the course (nothing saved)', async () => {
    stub.setReply(() => ({ status: 404, body: { error: 'unknown course "react-2023"' } }));
    const res = await request(port, 'PUT', '/api/profiles/mansi/journey', jsonBody({ link: link() }));
    expect(res.status).toBe(409);
    expect(res.json()).toMatchObject({ problem: 'unknown-course', courseId: 'react-2023', error: expect.stringContaining('ask Rahul') as unknown });
    expect(await readFile(path.join(dataDir, 'config.json'), 'utf8')).not.toContain(TOKEN);
  });

  it('v3: outbox lists rejected updates; retry (CSRF) re-queues them; ?wait= waits for the delivery (bounded)', async () => {
    await request(port, 'PUT', '/api/profiles/mansi/journey', jsonBody({ link: link() }));
    stub.setReply(() => ({ status: 400, body: { error: 'course "react-2023" is not a JS Journey course' } }));
    expect((await request(port, 'POST', '/api/journey/mansi/sessions', jsonBody(session('s1')))).status).toBe(202);
    const rejected = await request(port, 'GET', '/api/journey/mansi/outbox?wait=3000');
    expect(rejected.json()).toMatchObject({
      pending: 0,
      updates: [{ id: 's1', state: 'rejected', error: 'HTTP 400 — course "react-2023" is not a JS Journey course' }],
    });

    expect((await request(port, 'POST', '/api/journey/mansi/outbox/retry', { body: '{}' })).status).toBe(403);
    expect((await request(port, 'POST', '/api/journey/mansi/outbox/retry', jsonBody({ ids: 'all' }))).status).toBe(400);
    expect((await request(port, 'POST', '/api/journey/mansi/outbox/retry', jsonBody({ ids: [''] }))).status).toBe(400);
    expect((await request(port, 'POST', '/api/journey/nobody/outbox/retry', jsonBody({}))).status).toBe(404);
    stub.setReply(() => ({ status: 201, body: {} }));
    const retried = await request(port, 'POST', '/api/journey/mansi/outbox/retry', jsonBody({ ids: ['s1'] }));
    expect(retried.status).toBe(202);
    expect(retried.json()).toMatchObject({ pending: 1, updates: [{ id: 's1', state: 'queued' }] });
    const delivered = await request(port, 'GET', '/api/journey/mansi/outbox?wait=3000');
    expect(delivered.json()).toMatchObject({ pending: 0, lastError: null, updates: [{ id: 's1', state: 'delivered' }] });
    // an empty body retries all
    expect((await request(port, 'POST', '/api/journey/mansi/outbox/retry', { headers: { 'x-course-player': '1' } })).status).toBe(202);

    for (const bad of ['-1', '10001', 'soon', '1.5']) {
      expect((await request(port, 'GET', `/api/journey/mansi/outbox?wait=${bad}`)).status).toBe(400);
    }
  });

  it('proxies status and queues + delivers sessions for a connected profile', async () => {
    await request(port, 'PUT', '/api/profiles/mansi/journey', jsonBody({ link: link() }));
    const status = {
      pace: 'on-track',
      daysDelta: 0,
      week: 1,
      totalWeeks: 10,
      targetDate: '2026-12-11',
      deadline: '2026-12-18',
      goal: null,
      coachNote: null,
    };
    stub.setReply((req) => (req.method === 'GET' ? { status: 200, body: status } : { status: 201, body: { ok: true } }));
    const st = await request(port, 'GET', '/api/journey/mansi/status');
    expect(st.status).toBe(200);
    // this stub is a v1 JS Journey: the fields added since are filled, so the browser gets the full contract
    expect(st.json()).toEqual({ ...status, planBreak: null, sectionDue: {}, skippedSections: [], studyWeekdays: [1, 2, 3, 4, 5], planBreaks: [] });

    const posted = await request(port, 'POST', '/api/journey/mansi/sessions', jsonBody(session('s1')));
    expect(posted.status).toBe(202);
    // answered once it is saved: delivery runs after the reply (server/journey.ts queue())
    expect(posted.json()).toMatchObject({ pending: 1, lastError: null } satisfies Partial<OutboxState>);
    expect(await app.journey.settled('mansi')).toMatchObject({ pending: 0, lastError: null });
    expect(stub.seen.at(-1)).toMatchObject({ method: 'POST', url: '/api/player/sessions', auth: `Bearer ${TOKEN}` });

    const invalid = await request(port, 'POST', '/api/journey/mansi/sessions', jsonBody({ ...session('s2'), minutes: 0 }));
    expect(invalid.status).toBe(400);
    expect((invalid.json() as { error: string }).error).toMatch(/minutes/);
    // JS Journey would 400 these, and the outbox drops a 4xx'd update for good: refused here, up front
    const section0 = await request(port, 'POST', '/api/journey/mansi/sessions', jsonBody(session('s5', { sectionNumber: 0 })));
    expect((section0.json() as { error: string }).error).toMatch(/sectionNumber/);
    const dayAndMore = await request(port, 'POST', '/api/journey/mansi/sessions', jsonBody(session('s6', { minutes: 1441 })));
    expect((dayAndMore.json() as { error: string }).error).toMatch(/minutes/);
    const noteOnly = await request(port, 'POST', '/api/journey/mansi/sessions', jsonBody(session('s3', { minutes: 0, note: 'Read the docs on the train' })));
    expect(noteOnly.status).toBe(202);
    const noStuck = await request(port, 'POST', '/api/journey/mansi/sessions', jsonBody({ ...session('s4'), stuck: undefined }));
    expect((noStuck.json() as { error: string }).error).toMatch(/stuck/);

    // the note-only 202 does not wait for its delivery: read the outbox once it ran (it raced → pending 1)
    await app.journey.settled('mansi');
    const outbox = await request(port, 'GET', '/api/journey/mansi/outbox');
    expect(outbox.json()).toMatchObject({ pending: 0, lastError: null });
  });
});

describe('JS Journey v2 routes: feed, read receipts, progress', () => {
  const link = (): string => `${stub.origin}/m/${TOKEN}`;
  const connect = async (): Promise<void> => {
    expect((await request(port, 'PUT', '/api/profiles/mansi/journey', jsonBody({ link: link() }))).status).toBe(200);
    stub.seen.length = 0;
  };
  /** A working JS Journey: the feed answers `page`, every write 200. */
  const up = (page: JourneyFeed = feed()): void =>
    stub.setReply((req) => (req.url.startsWith('/api/player/feed?') ? { status: 200, body: page } : { status: 200, body: { ok: true } }));
  const down = (): void => stub.setReply(() => ({ status: 503, body: { error: 'maintenance' } }));
  const outboxFile = async (): Promise<{ reads: { id: string }[]; progress: ProgressSnapshot | null }> =>
    JSON.parse(await readFile(path.join(dataDir, 'outbox-mansi.json'), 'utf8')) as { reads: { id: string }[]; progress: ProgressSnapshot | null };
  /** the outbox once the background delivery a write started has run (the 202 does not wait for it) */
  const settled = (): Promise<OutboxState> => app.journey.settled('mansi');

  it('feed: 204 when not connected and nothing is cached', async () => {
    const res = await request(port, 'GET', '/api/journey/mansi/feed');
    expect(res.status).toBe(204);
    expect(stub.seen).toEqual([]);
  });

  it('feed: forwards the cursor, caches the first page, and serves it with x-course-player-stale: 1 when JS Journey is down', async () => {
    await connect();
    up();
    const fresh = await request(port, 'GET', '/api/journey/mansi/feed');
    expect(fresh.status).toBe(200);
    expect(fresh.headers['x-course-player-stale']).toBeUndefined();
    expect(fresh.headers['cache-control']).toBe('no-store');
    expect(fresh.json()).toEqual(feed());
    expect(stub.seen[0]).toMatchObject({ method: 'GET', url: '/api/player/feed?course=react-2023', auth: `Bearer ${TOKEN}` });

    const page2 = await request(port, 'GET', '/api/journey/mansi/feed?cursor=abc%3D%3D');
    expect(page2.status).toBe(200);
    expect(stub.seen[1]?.url).toBe('/api/player/feed?course=react-2023&cursor=abc%3D%3D');

    down();
    const stale = await request(port, 'GET', '/api/journey/mansi/feed?cursor=');
    expect(stale.status).toBe(200);
    expect(stale.headers['x-course-player-stale']).toBe('1');
    expect(stale.json()).toEqual(feed());
    expect((await request(port, 'GET', '/api/journey/mansi/feed?cursor=abc')).status).toBe(204); // later pages are not cached

    expect((await request(port, 'GET', `/api/journey/mansi/feed?cursor=${'x'.repeat(1001)}`)).status).toBe(400);
    expect((await request(port, 'GET', '/api/journey/nobody/feed')).status).toBe(404);
  });

  it('feed/read: CSRF header, 400 for a bad body, 409 when not connected, 202 forwarded', async () => {
    const ids = { ids: [M_REPLY] };
    expect((await request(port, 'POST', '/api/journey/mansi/feed/read', { body: JSON.stringify(ids) })).status).toBe(403);
    expect((await request(port, 'POST', '/api/journey/mansi/feed/read', jsonBody(ids))).status).toBe(409);
    await connect();
    up();
    const bad = await request(port, 'POST', '/api/journey/mansi/feed/read', jsonBody({ ids: [] }));
    expect(bad.status).toBe(400);
    expect((bad.json() as { error: string }).error).toMatch(/ids/);
    // JS Journey wants uuids: anything else is refused here, not queued to be 4xx'd (and dropped) later
    const notUuid = await request(port, 'POST', '/api/journey/mansi/feed/read', jsonBody({ ids: [M_REPLY, 'm-reply'] }));
    expect(notUuid.status).toBe(400);
    const res = await request(port, 'POST', '/api/journey/mansi/feed/read', jsonBody({ ids: [M_REPLY, M_REPLY] }));
    expect(res.status).toBe(202);
    expect(res.json()).toMatchObject({ pending: 0, lastError: null } satisfies Partial<OutboxState>);
    await settled();
    expect(stub.seen.map((s) => [s.method, s.url, s.body])).toEqual([['POST', '/api/player/feed/read', JSON.stringify({ ids: [M_REPLY] })]]);
  });

  it('feed/read while JS Journey is down: queued, the cached feed shows them read, delivered on the next flush', async () => {
    await connect();
    up();
    await request(port, 'GET', '/api/journey/mansi/feed');
    down();
    const res = await request(port, 'POST', '/api/journey/mansi/feed/read', jsonBody({ ids: [M_REPLY, M_NOTE] }));
    expect(res.status).toBe(202);
    expect((await settled()).lastError).toBe('HTTP 503 — maintenance');
    const stale = await request(port, 'GET', '/api/journey/mansi/feed');
    expect(stale.headers['x-course-player-stale']).toBe('1');
    const shown = stale.json() as JourneyFeed;
    expect(shown.unreadForStudent).toBe(0);
    expect(shown.notes[0]?.readAt).toEqual(expect.any(String));
    // the same "Got it" again (a retried click) changes nothing
    await request(port, 'POST', '/api/journey/mansi/feed/read', jsonBody({ ids: [M_NOTE] }));
    await settled();
    expect((await outboxFile()).reads.map((r) => r.id)).toEqual([M_REPLY, M_NOTE]);
    up();
    stub.seen.length = 0;
    await app.journey.flush('mansi');
    expect(stub.seen.map((s) => [s.url, s.body])).toEqual([['/api/player/feed/read', JSON.stringify({ ids: [M_REPLY, M_NOTE] })]]);
  });

  it('progress: CSRF header, 400 for an invalid snapshot, 409 when not connected, 202 forwarded; newest wins while offline', async () => {
    expect((await request(port, 'PUT', '/api/journey/mansi/progress', { body: JSON.stringify(snapshot(1)) })).status).toBe(403);
    expect((await request(port, 'PUT', '/api/journey/mansi/progress', jsonBody(snapshot(1)))).status).toBe(409);
    await connect();
    up();
    const bad = await request(port, 'PUT', '/api/journey/mansi/progress', jsonBody(snapshot(1, { course: 'vue' })));
    expect(bad.status).toBe(400);
    expect((bad.json() as { error: string }).error).toMatch(/course/);
    const ok = await request(port, 'PUT', '/api/journey/mansi/progress', jsonBody(snapshot(100)));
    expect(ok.status).toBe(202);
    await settled();
    expect(stub.seen.map((s) => [s.method, s.url])).toEqual([['PUT', '/api/player/progress']]);

    down();
    await request(port, 'PUT', '/api/journey/mansi/progress', jsonBody(snapshot(300)));
    await request(port, 'PUT', '/api/journey/mansi/progress', jsonBody(snapshot(200)));
    await settled();
    expect((await outboxFile()).progress?.takenAt).toBe(300);
  });

  it('quit delivers queued read receipts and the snapshot too', async () => {
    await connect();
    down();
    await request(port, 'POST', '/api/journey/mansi/feed/read', jsonBody({ ids: [msgId(11)] }));
    await request(port, 'PUT', '/api/journey/mansi/progress', jsonBody(snapshot(7)));
    await settled();
    up();
    stub.seen.length = 0;
    expect((await request(port, 'POST', '/api/quit', { headers: { 'x-course-player': '1' } })).status).toBe(202);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 3000 });
    expect(stub.seen.map((s) => s.url)).toEqual(['/api/player/feed/read', '/api/player/progress']);
  });
});

describe('media + static', () => {
  it('streams media with ranges and refuses traversal (raw path, not the static fallback)', async () => {
    const res = await request(port, 'GET', '/media/01%20Welcome/01%20Intro.mp4', { headers: { range: 'bytes=0-9' } });
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toMatch(/^bytes 0-9\/\d+$/);
    expect((await request(port, 'GET', '/media/../data/config.json')).status).toBe(404);
    expect((await request(port, 'GET', '/media/%2e%2e/data/config.json')).status).toBe(404);
  });

  it('serves index.html (no-cache), immutable /assets, SPA fallback, and 404 for missing assets', async () => {
    const index = await request(port, 'GET', '/');
    expect(index.status).toBe(200);
    expect(index.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(index.headers['cache-control']).toBe('no-cache');
    expect(index.text).toContain('<title>Course Player</title>');

    const js = await request(port, 'GET', '/assets/app-abc123.js');
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await request(port, 'GET', '/assets/app-abc123.css')).headers['content-type']).toBe('text/css; charset=utf-8');

    const fallback = await request(port, 'GET', '/watch/whatever');
    expect(fallback.status).toBe(200);
    expect(fallback.text).toContain('<title>Course Player</title>');
    expect((await request(port, 'GET', '/assets/missing.js')).status).toBe(404);
    expect((await request(port, 'POST', '/', { body: '' })).status).toBe(405);
  });

  it('still runs without a web dir and answers / with a short plain-text note', async () => {
    await app.stop();
    await boot({ web: false });
    const res = await request(port, 'GET', '/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.text).toMatch(/web app is not built/);
    expect((await request(port, 'GET', '/api/ping')).status).toBe(200);
  });
});

describe('quit', () => {
  it('replies 202, flushes outboxes, closes the server, then exits 0', async () => {
    await request(port, 'PUT', '/api/profiles/mansi/journey', jsonBody({ link: link() }));
    // a session that could not be delivered earlier sits in the outbox
    await writeFile(
      path.join(dataDir, 'outbox-mansi.json'),
      JSON.stringify({ v: 1, items: [session('pending-1')], lastError: 'HTTP 503 — down' }),
    );
    stub.seen.length = 0;
    const res = await request(port, 'POST', '/api/quit', { headers: { 'x-course-player': '1' } });
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 3000 });
    expect(stub.seen.map((s) => s.url)).toEqual(['/api/player/sessions']);
    expect(app.server.listening).toBe(false);
  });

  function link(): string {
    return `${stub.origin}/m/${TOKEN}`;
  }
});

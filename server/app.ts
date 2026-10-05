// The course server: routing + the two request-level rules every route relies on.
//
// 1. Single origin. localStorage is per ORIGIN and `localhost:8795` != `127.0.0.1:8795`, so any request
//    whose Host is not exactly `localhost:<port>` is 308'd there. Otherwise opening the app via
//    127.0.0.1 shows an empty progress history. (Vite's dev proxy rewrites Host to the target —
//    `changeOrigin: true` is the default for its string shorthand — so dev requests pass.)
// 2. CSRF. Every non-GET/HEAD /api/* request must carry `x-course-player: 1`. A custom header forces a
//    CORS preflight from any foreign page, which we never answer, so no website can POST /api/quit.
//    Do not add CORS headers or answer OPTIONS here: that would switch this protection off.
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BootPayload, Course, JourneySession, ProgressSnapshot, ProgressState } from '../shared/types.ts';
import { ConfigStore, PROFILE_ID_RE } from './config.ts';
import { folderCourseId, resolveCourseId, type ResolvedCourseId } from './course-id.ts';
import { HttpError, readJsonBody, sendEmpty, sendJson } from './http.ts';
import { Journey, OUTBOX_WAIT_MAX_MS, parseReadIds, parseRetryIds, validateProgressSnapshot, validateSession } from './journey.ts';
import { errorMessage, type Log } from './log.ts';
import { serveMedia } from './media.ts';
import { scanCourse } from './scan.ts';
import { serveStatic } from './static.ts';
import { ProgressStore, validateProgress } from './store.ts';

const BODY_LIMIT = 2 * 1024 * 1024;
const CURSOR_MAX = 1000;
/** Set on a feed served from the last good copy (JS Journey unreachable or failing). shared/types.ts
 *  names it in the route list; the web app reads it to say the feed may be out of date. */
const STALE_HEADER = 'x-course-player-stale';

export interface AppOptions {
  root: string;
  dataDir: string;
  webDir: string;
  version: string;
  log: Log;
  /** called once POST /api/quit (or a signal) has flushed outboxes and closed the server */
  exit: (code: number) => void;
  journeyTimeoutMs?: number;
  /** how long quit waits for JS Journey deliveries (spec: max 3 s) */
  quitFlushMs?: number;
}

export interface CourseServer {
  server: http.Server;
  journey: Journey;
  /** Course.id and where it came from (course-id.ts) */
  courseId: ResolvedCourseId;
  /** binds 127.0.0.1 only; resolves with the bound port */
  listen: (port: number) => Promise<number>;
  /** the scanned course (the initial scan; retried if it failed) */
  course: () => Promise<Course>;
  /** flush outboxes (bounded), close, then exit(0) — for quit and signals */
  shutdown: (reason: string) => Promise<void>;
  /** close without exiting (tests) */
  stop: () => Promise<void>;
}

type Handler = (ctx: { req: http.IncomingMessage; res: http.ServerResponse; params: string[] }) => Promise<void>;
type Route = { pattern: RegExp; methods: Partial<Record<string, Handler>> };

export async function createCourseServer(opts: AppOptions): Promise<CourseServer> {
  const { root, dataDir, webDir, version, log } = opts;
  await mkdir(dataDir, { recursive: true });
  const config = await ConfigStore.load(dataDir);
  if (!config.exists) log(`[config] no config.json in ${dataDir} — using the folder name as title and no profiles`);
  // Pinned, never just the folder name (2026-10-05: her copy's folder → "react-course" → every update
  // 4xx'd). Throws on an invalid .player/course.json: main exits loudly, like for config.json.
  const resolved = await resolveCourseId({ root, config, log });
  const courseId = resolved.id;
  const progress = new ProgressStore(dataDir, log);
  const journey = new Journey({ dataDir, config, courseId, log, timeoutMs: opts.journeyTimeoutMs });

  let scan: Promise<Course> | null = null;
  let scanFailed = false;
  const course = (): Promise<Course> => {
    if (scan === null || scanFailed) {
      scanFailed = false;
      scan = scanCourse({ root, dataDir, courseId, title: config.title, subtitle: config.subtitle, log }).then(
        (r) => r.course,
        (err: unknown) => {
          scanFailed = true; // the next /api/boot retries (e.g. the SSD was reconnected)
          log(`[scan] failed for ${root}: ${errorMessage(err)}`);
          throw new HttpError(503, "Couldn't read the course folder — is the SSD connected?");
        },
      );
      // Rejections reach /api/boot callers; this only stops an unawaited first scan from crashing.
      scan.catch(() => undefined);
    }
    return scan;
  };

  const profileParam = (raw: string): string => {
    let id: string;
    try {
      id = decodeURIComponent(raw);
    } catch {
      throw new HttpError(404, 'Unknown profile');
    }
    if (!PROFILE_ID_RE.test(id) || !config.has(id)) throw new HttpError(404, 'Unknown profile');
    return id;
  };

  let stopping = false;
  const routes: Route[] = [
    {
      pattern: /^\/api\/ping$/,
      methods: { GET: async ({ res }) => sendJson(res, 200, { app: 'course-player', version }) },
    },
    {
      pattern: /^\/api\/boot$/,
      methods: {
        GET: async ({ res }) => {
          const payload: BootPayload = {
            course: await course(),
            profiles: config.profiles(),
            version,
            courseIdFrom: resolved.from,
            folderCourseId: folderCourseId(root),
          };
          sendJson(res, 200, payload);
        },
      },
    },
    {
      pattern: /^\/api\/progress\/([^/]+)$/,
      methods: {
        GET: async ({ res, params }) => {
          const stored = await progress.get(profileParam(params[0] as string));
          if (stored === null) sendEmpty(res, 204);
          else sendJson(res, 200, stored);
        },
        PUT: async ({ req, res, params }) => {
          const profile = profileParam(params[0] as string);
          const body = await readJsonBody(req, BODY_LIMIT);
          const problem = validateProgress(body);
          if (problem !== null) throw new HttpError(400, problem);
          sendJson(res, 200, await progress.put(profile, body as ProgressState)); // shape proved just above
        },
      },
    },
    {
      pattern: /^\/api\/profiles\/([^/]+)\/journey$/,
      methods: {
        PUT: async ({ req, res, params }) => {
          const profile = profileParam(params[0] as string);
          const body = await readJsonBody(req, BODY_LIMIT);
          const link = typeof body === 'object' && body !== null ? (body as { link?: unknown }).link : undefined;
          const check = await journey.checkLink(link);
          if (!check.ok) {
            log(`[journey] ${profile}: link not saved (${check.status === 400 ? 'malformed' : check.message})`);
            throw new HttpError(check.status, check.message, check.status === 409 ? { ...check.problem } : {});
          }
          const saved = await config.setJourneyLink(profile, check.link);
          log(`[journey] ${profile}: connected`);
          // deliver everything kept while not connected (v3) and give rejected updates another go — a new
          // link is a fix like a restart. Local file work only; JS Journey is called in the background.
          // The link IS saved by now: a failure here is logged, not answered as a failed connect.
          await journey.retry(profile, undefined, 'connected').catch((err: unknown) => {
            log(`[journey] ${profile}: delivery after connecting failed to start — ${errorMessage(err)}`);
          });
          sendJson(res, 200, saved);
        },
        DELETE: async ({ res, params }) => {
          const profile = profileParam(params[0] as string);
          const saved = await config.setJourneyLink(profile, null);
          log(`[journey] ${profile}: disconnected`);
          sendJson(res, 200, saved);
        },
      },
    },
    {
      pattern: /^\/api\/journey\/([^/]+)\/status$/,
      methods: {
        GET: async ({ res, params }) => {
          const result = await journey.status(profileParam(params[0] as string));
          if (result.kind === 'status') sendJson(res, 200, result.status);
          // v3: a course JS Journey does not know is shown to her (menu: "course not recognised"), never a
          // silent 204 that looks like "offline" — that is how the 2026-10-05 sign-off vanished unnoticed
          else if (result.kind === 'problem') sendJson(res, 409, result.problem);
          else sendEmpty(res, 204);
        },
      },
    },
    {
      pattern: /^\/api\/journey\/([^/]+)\/sessions$/,
      methods: {
        POST: async ({ req, res, params }) => {
          const profile = profileParam(params[0] as string);
          const body = await readJsonBody(req, BODY_LIMIT);
          const problem = validateSession(body, courseId);
          if (problem !== null) throw new HttpError(400, problem);
          // v3: accepted while not connected too — kept in the outbox, delivered once she connects (v2
          // 409'd here and the browser forgot the update)
          sendJson(res, 202, await journey.enqueue(profile, body as JourneySession)); // shape proved just above
        },
      },
    },
    {
      pattern: /^\/api\/journey\/([^/]+)\/feed$/,
      methods: {
        GET: async ({ req, res, params }) => {
          const profile = profileParam(params[0] as string);
          const cursor = new URL(req.url ?? '/', 'http://localhost').searchParams.get('cursor') || null; // "" = first page
          if (cursor !== null && cursor.length > CURSOR_MAX) throw new HttpError(400, 'cursor is too long');
          const result = await journey.feed(profile, cursor);
          if (result === null) sendEmpty(res, 204);
          else sendJson(res, 200, result.feed, result.stale ? { [STALE_HEADER]: '1' } : {});
        },
      },
    },
    {
      pattern: /^\/api\/journey\/([^/]+)\/feed\/read$/,
      methods: {
        POST: async ({ req, res, params }) => {
          const profile = profileParam(params[0] as string);
          const parsed = parseReadIds(await readJsonBody(req, BODY_LIMIT));
          if (!parsed.ok) throw new HttpError(400, parsed.error);
          const state = await journey.enqueueReads(profile, parsed.ids);
          if (state === null) throw new HttpError(409, 'This profile is not connected to JS Journey');
          sendJson(res, 202, state);
        },
      },
    },
    {
      pattern: /^\/api\/journey\/([^/]+)\/progress$/,
      methods: {
        PUT: async ({ req, res, params }) => {
          const profile = profileParam(params[0] as string);
          const body = await readJsonBody(req, BODY_LIMIT);
          const problem = validateProgressSnapshot(body, courseId);
          if (problem !== null) throw new HttpError(400, problem);
          const state = await journey.enqueueProgress(profile, body as ProgressSnapshot); // shape proved just above
          if (state === null) throw new HttpError(409, 'This profile is not connected to JS Journey');
          sendJson(res, 202, state);
        },
      },
    },
    {
      pattern: /^\/api\/journey\/([^/]+)\/outbox$/,
      methods: {
        GET: async ({ req, res, params }) => {
          const profile = profileParam(params[0] as string);
          const raw = new URL(req.url ?? '/', 'http://localhost').searchParams.get('wait') ?? '0';
          const wait = /^\d{1,5}$/.test(raw) ? Number(raw) : Number.NaN;
          if (!(wait >= 0 && wait <= OUTBOX_WAIT_MAX_MS)) throw new HttpError(400, `wait must be 0–${OUTBOX_WAIT_MAX_MS} ms`);
          sendJson(res, 200, await journey.outbox(profile, wait));
        },
      },
    },
    {
      pattern: /^\/api\/journey\/([^/]+)\/outbox\/retry$/,
      methods: {
        POST: async ({ req, res, params }) => {
          const profile = profileParam(params[0] as string);
          const parsed = parseRetryIds(await readJsonBody(req, BODY_LIMIT, { allowEmpty: true }));
          if (!parsed.ok) throw new HttpError(400, parsed.error);
          sendJson(res, 202, await journey.retry(profile, parsed.ids));
        },
      },
    },
    {
      pattern: /^\/api\/quit$/,
      methods: {
        POST: async ({ res }) => {
          res.once('finish', () => {
            void shutdown('quit');
          });
          sendJson(res, 202, { stopping: true });
        },
      },
    },
  ];

  async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, rawPath: string, method: string): Promise<void> {
    if (method !== 'GET' && method !== 'HEAD' && req.headers['x-course-player'] !== '1') {
      throw new HttpError(403, 'Missing x-course-player header');
    }
    for (const route of routes) {
      const m = route.pattern.exec(rawPath);
      if (!m) continue;
      const handler = route.methods[method === 'HEAD' ? 'GET' : method];
      if (!handler) throw new HttpError(405, `${method} is not allowed here`);
      await handler({ req, res, params: m.slice(1) });
      return;
    }
    throw new HttpError(404, 'No such API route');
  }

  let boundPort = 0;
  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const rawUrl = req.url?.startsWith('/') ? req.url : '/';
    if (req.headers.host !== `localhost:${boundPort}`) {
      res.writeHead(308, { location: `http://localhost:${boundPort}${rawUrl}`, 'content-length': 0 });
      res.end();
      return;
    }
    const rawPath = rawUrl.split('?')[0] as string;
    const method = req.method ?? 'GET';
    if (rawPath.startsWith('/api/')) return handleApi(req, res, rawPath, method);
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, `${method} is not allowed here`);
    // Raw (undecoded, unnormalized) path on purpose: see the guard comment in media.ts.
    if (rawPath.startsWith('/media/')) return serveMedia(req, res, root, rawPath.slice('/media/'.length), log);
    return serveStatic(req, res, webDir, rawPath);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        log(`[http] ${req.method} ${req.url} failed mid-response: ${errorMessage(err)}`);
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { ...err.body, error: err.message });
        return;
      }
      log(`[http] ${req.method} ${req.url} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      sendJson(res, 500, { error: 'Internal error' });
    });
  });

  const listen = (port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError);
        boundPort = (server.address() as AddressInfo).port;
        // Scan only once we own the port: an "already running" start must not race the running
        // server's durations.json write.
        void course();
        resolve(boundPort);
      });
    });

  const stop = (): Promise<void> =>
    new Promise((resolve) => {
      journey.stop();
      if (!server.listening) return resolve();
      server.close(() => resolve());
      server.closeAllConnections(); // in-flight media streams included; their read streams get destroyed
    });

  async function shutdown(reason: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    log(`[server] stopping (${reason})`);
    journey.stop();
    try {
      await journey.flushAll(opts.quitFlushMs ?? 3000);
    } catch (err) {
      log(`[journey] flush on quit failed: ${errorMessage(err)}`);
    }
    await stop();
    opts.exit(0);
  }

  return { server, journey, courseId: resolved, listen, course, shutdown, stop };
}

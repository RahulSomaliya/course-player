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
import type { BootPayload, Course, JourneySession, ProgressState } from '../shared/types.ts';
import { ConfigStore, PROFILE_ID_RE } from './config.ts';
import { HttpError, readJsonBody, sendEmpty, sendJson } from './http.ts';
import { Journey, validateSession } from './journey.ts';
import { errorMessage, type Log } from './log.ts';
import { serveMedia } from './media.ts';
import { courseIdFor, scanCourse } from './scan.ts';
import { serveStatic } from './static.ts';
import { ProgressStore, validateProgress } from './store.ts';

const BODY_LIMIT = 2 * 1024 * 1024;

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
  const courseId = courseIdFor(root);
  const progress = new ProgressStore(dataDir, log);
  const journey = new Journey({ dataDir, config, courseId, log, timeoutMs: opts.journeyTimeoutMs });

  let scan: Promise<Course> | null = null;
  let scanFailed = false;
  const course = (): Promise<Course> => {
    if (scan === null || scanFailed) {
      scanFailed = false;
      scan = scanCourse({ root, dataDir, title: config.title, subtitle: config.subtitle, log }).then(
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
          const payload: BootPayload = { course: await course(), profiles: config.profiles(), version };
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
            throw new HttpError(check.status, check.message);
          }
          const saved = await config.setJourneyLink(profile, check.link);
          log(`[journey] ${profile}: connected`);
          // deliver anything queued before a reconnect; failures are logged, the reply doesn't wait
          journey.flush(profile).catch((err: unknown) => log(`[journey] ${profile}: flush failed: ${errorMessage(err)}`));
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
          const status = await journey.status(profileParam(params[0] as string));
          if (status === null) sendEmpty(res, 204);
          else sendJson(res, 200, status);
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
          const state = await journey.enqueue(profile, body as JourneySession); // shape proved just above
          if (state === null) throw new HttpError(409, 'This profile is not connected to JS Journey');
          sendJson(res, 202, state);
        },
      },
    },
    {
      pattern: /^\/api\/journey\/([^/]+)\/outbox$/,
      methods: {
        GET: async ({ res, params }) => sendJson(res, 200, await journey.outbox(profileParam(params[0] as string))),
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
        sendJson(res, err.status, { error: err.message });
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

  return { server, journey, listen, course, shutdown, stop };
}

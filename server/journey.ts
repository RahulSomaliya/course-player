// JS Journey bridge (Mansi's study tracker): status proxy, student-link check, and the session
// outbox <data>/outbox-<profile>.json (docs/spec.md §2 "Outbox -> JS Journey").
//
// Delivery rules: 2xx -> remove. 4xx -> remove too and keep the message in lastError (a permanent
// rejection must not retry forever). Network error / 5xx -> keep and stop this flush (the rest would
// fail the same way); retried on start-up, every 5 min, on each new session and on quit. JS Journey
// dedups on session.id, so re-sending after a lost response is safe.
//
// The token rides only in the Authorization header. The URLs we call never contain it, and log lines
// carry the profile id + HTTP status/message only — never the link.
import { rename } from 'node:fs/promises';
import path from 'node:path';
import type { JourneySession, JourneyStatus, OutboxState } from '../shared/types.ts';
import type { ConfigStore } from './config.ts';
import { errorMessage, type Log } from './log.ts';
import { JsonFileError, KeyedMutex, readJsonFile, writeFileAtomic } from './store.ts';

const RETRY_EVERY_MS = 5 * 60 * 1000;
const MOODS = new Set(['😄', '🙂', '😐', '😩']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const TOKEN_PATH_RE = /^\/m\/([A-Za-z0-9._~-]+)\/?$/;

export interface StudentLink {
  origin: string;
  token: string;
}

/** `https://<host>/m/<token>` (plain http only for loopback hosts, i.e. dev + tests). */
export function parseStudentLink(link: unknown): StudentLink | null {
  if (typeof link !== 'string') return null;
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null; // not a URL at all -> the caller answers 400
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  if (!secure || url.username !== '' || url.password !== '') return null;
  const m = TOKEN_PATH_RE.exec(url.pathname);
  if (!m) return null;
  return { origin: url.origin, token: m[1] as string };
}

// ---- validation ------------------------------------------------------------------------------

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
const isInt = (x: unknown, min: number): x is number => Number.isInteger(x) && (x as number) >= min;
const isIsoDate = (x: unknown): boolean => typeof x === 'string' && !Number.isNaN(Date.parse(x));
const isString = (x: unknown): x is string => typeof x === 'string';

/** null when `x` is a JourneySession for `courseId`, else the first problem. */
export function validateSession(x: unknown, courseId: string): string | null {
  if (!isRecord(x)) return 'body must be a JourneySession object';
  if (!isString(x.id) || x.id.length === 0 || x.id.length > 100) return 'id must be a non-empty string';
  if (x.course !== courseId) return `course must be "${courseId}"`;
  if (!isIsoDate(x.startedAt)) return 'startedAt must be an ISO date';
  if (!isIsoDate(x.endedAt)) return 'endedAt must be an ISO date';
  if (!isString(x.studyDate) || !/^\d{4}-\d{2}-\d{2}$/.test(x.studyDate)) return 'studyDate must be YYYY-MM-DD';
  if (!isInt(x.minutes, 1)) return 'minutes must be an integer >= 1';
  if (!isInt(x.sectionNumber, 0)) return 'sectionNumber must be an integer';
  if (
    !Array.isArray(x.lecturesCompleted) ||
    !x.lecturesCompleted.every((l: unknown) => isRecord(l) && isInt(l.section, 0) && isInt(l.lecture, 0) && isString(l.title))
  ) {
    return 'lecturesCompleted must be [{section, lecture, title}]';
  }
  if (!Array.isArray(x.finishedSections) || !x.finishedSections.every((n: unknown) => isInt(n, 0))) {
    return 'finishedSections must be section numbers';
  }
  if (!(x.mood === null || (isString(x.mood) && MOODS.has(x.mood)))) return 'mood must be one of 😄 🙂 😐 😩 or null';
  if (!(x.note === null || (isString(x.note) && x.note.length <= 2000))) return 'note must be a string (<= 2000 chars) or null';
  return null;
}

const isDay = (x: unknown): x is string => isString(x) && /^\d{4}-\d{2}-\d{2}$/.test(x);

/** `planBreak` may be missing (a JS Journey deployed before it existed — web/src/lib/plan.ts reads it
 *  `?? null`), null, or a well-formed inclusive day range. Anything else fails the whole status (→ 204),
 *  so the browser never receives a break it would mis-render. Keep in sync with shared/types.ts. */
function isPlanBreak(x: unknown): boolean {
  if (x === undefined || x === null) return true;
  return isRecord(x) && isString(x.label) && isDay(x.start) && isDay(x.end) && x.start <= x.end;
}

export function isJourneyStatus(x: unknown): x is JourneyStatus {
  if (!isRecord(x)) return false;
  const goalOk =
    x.goal === null || (isRecord(x.goal) && typeof x.goal.sectionNumber === 'number' && isString(x.goal.title) && isString(x.goal.due));
  const noteOk = x.coachNote === null || (isRecord(x.coachNote) && isString(x.coachNote.body) && isString(x.coachNote.createdAt));
  return (
    (x.pace === 'ahead' || x.pace === 'on-track' || x.pace === 'behind') &&
    typeof x.daysDelta === 'number' &&
    typeof x.week === 'number' &&
    typeof x.totalWeeks === 'number' &&
    isString(x.targetDate) &&
    isString(x.deadline) &&
    goalOk &&
    noteOk &&
    isPlanBreak(x.planBreak)
  );
}

// ---- HTTP to JS Journey ------------------------------------------------------------------------

type SendResult = { kind: 'sent' } | { kind: 'rejected'; message: string } | { kind: 'retry'; message: string };

/** "Session overlaps…" from {error}/{message} JSON, else the trimmed text, else the status text. */
async function describeFailure(res: Response): Promise<string> {
  const text = (await res.text()).slice(0, 2000);
  try {
    const body: unknown = JSON.parse(text);
    if (isRecord(body)) {
      if (isString(body.error) && body.error !== '') return body.error.slice(0, 200);
      if (isString(body.message) && body.message !== '') return body.message.slice(0, 200);
    }
  } catch {
    // not JSON — fall through to the plain text
  }
  const plain = text.replace(/\s+/g, ' ').trim().slice(0, 200);
  return plain !== '' ? plain : res.statusText || 'no message';
}

function networkMessage(err: unknown): string {
  if (err instanceof Error && err.name === 'TimeoutError') return 'unreachable — timed out';
  const cause = err instanceof Error ? (err.cause as NodeJS.ErrnoException | undefined) : undefined;
  return `unreachable — ${cause?.code ?? errorMessage(err)}`;
}

// ---- outbox ----------------------------------------------------------------------------------

interface OutboxFile {
  v: 1;
  items: JourneySession[];
  lastError: string | null;
}

const view = (o: OutboxFile): OutboxState => ({ pending: o.items.length, lastError: o.lastError });

export interface JourneyOptions {
  dataDir: string;
  config: ConfigStore;
  /** Course.id — the `course` JS Journey files sessions/status under */
  courseId: string;
  log: Log;
  /** per-request timeout; 5 s in production */
  timeoutMs?: number;
}

export type LinkCheck = { ok: true; link: string } | { ok: false; status: 400 | 502; message: string };

export class Journey {
  private readonly locks = new KeyedMutex();
  private readonly timeoutMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: JourneyOptions) {
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  private linkFor(profile: string): StudentLink | null {
    return parseStudentLink(this.opts.config.journeyLink(profile));
  }

  private file(profile: string): string {
    return path.join(this.opts.dataDir, `outbox-${profile}.json`);
  }

  private async load(profile: string): Promise<OutboxFile> {
    const file = this.file(profile);
    let raw: unknown;
    try {
      raw = await readJsonFile(file);
    } catch (err) {
      if (!(err instanceof JsonFileError)) throw err;
      return this.moveAside(profile, file);
    }
    if (raw === undefined) return { v: 1, items: [], lastError: null };
    if (!isRecord(raw) || !Array.isArray(raw.items) || !(raw.lastError === null || isString(raw.lastError))) {
      return this.moveAside(profile, file);
    }
    return { v: 1, items: raw.items as JourneySession[], lastError: raw.lastError }; // shape checked above
  }

  /** Never silently lose pending sessions: keep the unreadable file for inspection, start empty. */
  private async moveAside(profile: string, file: string): Promise<OutboxFile> {
    await rename(file, `${file}.corrupt`);
    this.opts.log(`[journey] ${profile}: ${path.basename(file)} is unreadable — moved aside to ${path.basename(file)}.corrupt`);
    return { v: 1, items: [], lastError: null };
  }

  private save(profile: string, outbox: OutboxFile): Promise<void> {
    return writeFileAtomic(this.file(profile), JSON.stringify(outbox));
  }

  private async send(link: StudentLink, session: JourneySession, timeoutMs: number): Promise<SendResult> {
    let res: Response;
    try {
      res = await fetch(`${link.origin}/api/player/sessions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${link.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(session),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      return { kind: 'retry', message: networkMessage(err) };
    }
    if (res.ok) {
      await res.body?.cancel();
      return { kind: 'sent' };
    }
    const message = `HTTP ${res.status} — ${await describeFailure(res)}`;
    return res.status >= 400 && res.status < 500 ? { kind: 'rejected', message } : { kind: 'retry', message };
  }

  outbox(profile: string): Promise<OutboxState> {
    return this.locks.run(profile, async () => view(await this.load(profile)));
  }

  /** Queues a validated session and tries to deliver it now. null = profile not connected. */
  async enqueue(profile: string, session: JourneySession): Promise<OutboxState | null> {
    if (!this.linkFor(profile)) return null;
    await this.locks.run(profile, async () => {
      const outbox = await this.load(profile);
      const i = outbox.items.findIndex((s) => s.id === session.id);
      if (i >= 0) outbox.items[i] = session;
      else outbox.items.push(session);
      await this.save(profile, outbox);
    });
    return this.flush(profile);
  }

  /** Sends pending sessions in order until done, a transient failure, or `deadline` (epoch ms). */
  flush(profile: string, deadline = Number.POSITIVE_INFINITY): Promise<OutboxState> {
    return this.locks.run(profile, async () => {
      const outbox = await this.load(profile);
      const link = this.linkFor(profile);
      if (!link || outbox.items.length === 0) return view(outbox);
      const { log } = this.opts;
      let sent = 0;
      let attempted = false;
      let error: string | null = null;
      while (outbox.items.length > 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        attempted = true;
        const session = outbox.items[0] as JourneySession;
        const result = await this.send(link, session, Math.min(this.timeoutMs, remaining));
        if (result.kind === 'retry') {
          error = result.message;
          log(`[journey] ${profile}: ${result.message}, ${outbox.items.length} pending`);
          break;
        }
        outbox.items.shift();
        if (result.kind === 'sent') sent++;
        else {
          error = result.message;
          log(`[journey] ${profile}: ${result.message} (session ${session.id} dropped)`);
        }
      }
      if (!attempted) return view(outbox);
      // lastError describes the latest flush: a fully delivered flush clears it.
      outbox.lastError = error;
      await this.save(profile, outbox);
      if (sent > 0) log(`[journey] ${profile}: sent ${sent}, ${outbox.items.length} pending`);
      return view(outbox);
    });
  }

  /** Flushes every connected profile; gives up after `withinMs` (quit uses 3 s). */
  async flushAll(withinMs: number): Promise<void> {
    const deadline = Date.now() + withinMs;
    const all = Promise.all(this.opts.config.connectedProfileIds().map((p) => this.flush(p, deadline)));
    let timer: NodeJS.Timeout | undefined;
    const cutoff = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, withinMs + 100);
    });
    try {
      await Promise.race([all.then(() => undefined), cutoff]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Start-up flush + retry every 5 min. The timer never keeps the process alive. */
  start(): void {
    const run = (): void => {
      this.flushAll(this.timeoutMs * 2).catch((err: unknown) => {
        this.opts.log(`[journey] retry failed: ${errorMessage(err)}`);
      });
    };
    run();
    this.timer = setInterval(run, RETRY_EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** GET <origin>/api/player/status?course=<id>; null when not connected, unreachable, non-2xx or malformed. */
  async status(profile: string): Promise<JourneyStatus | null> {
    const link = this.linkFor(profile);
    if (!link) return null;
    const { log } = this.opts;
    let res: Response;
    try {
      res = await this.getStatus(link);
    } catch (err) {
      log(`[journey] ${profile}: status ${networkMessage(err)}`);
      return null;
    }
    if (res.status === 204 || !res.ok) {
      if (!res.ok) log(`[journey] ${profile}: status HTTP ${res.status} — ${await describeFailure(res)}`);
      else await res.body?.cancel();
      return null;
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      log(`[journey] ${profile}: status body is not JSON — ${errorMessage(err)}`);
      return null;
    }
    if (!isJourneyStatus(body)) {
      log(`[journey] ${profile}: status body has an unexpected shape`);
      return null;
    }
    return body;
  }

  /** Validates a pasted student link by asking JS Journey for this course's status with it. */
  async checkLink(raw: unknown): Promise<LinkCheck> {
    const link = parseStudentLink(raw);
    if (!link) return { ok: false, status: 400, message: 'That is not a JS Journey student link (https://…/m/…).' };
    let res: Response;
    try {
      res = await this.getStatus(link);
    } catch (err) {
      return { ok: false, status: 502, message: `Couldn't reach JS Journey (${networkMessage(err)}).` };
    }
    if (!res.ok) {
      const why = await describeFailure(res);
      return { ok: false, status: 502, message: `JS Journey did not accept this link (HTTP ${res.status} — ${why}).` };
    }
    await res.body?.cancel();
    return { ok: true, link: `${link.origin}/m/${link.token}` };
  }

  private getStatus(link: StudentLink): Promise<Response> {
    const url = `${link.origin}/api/player/status?course=${encodeURIComponent(this.opts.courseId)}`;
    return fetch(url, { headers: { authorization: `Bearer ${link.token}` }, signal: AbortSignal.timeout(this.timeoutMs) });
  }
}

// JS Journey bridge (Mansi's study tracker; Rahul coaches her there): status proxy, student-link check,
// the coach feed with its last good copy, and the outbox <data>/outbox-<profile>.json
// (docs/spec.md §2 "Outbox -> JS Journey", docs/spec-v2-coaching.md).
//
// The outbox holds everything the player owes JS Journey: her updates (sessions, oldest first), the
// read receipts for coach messages she acknowledged, and the newest progress snapshot (latest wins on
// takenAt). A flush sends them in that order. Delivery rules, the same for all three: 2xx -> remove.
// 4xx -> remove too and keep the message in lastError (a permanent rejection must not retry forever) —
// which is why validation here must be at least as strict as JS Journey's (lib/player.ts there): an
// item it would 400 is refused to the browser up front, never queued to be dropped later.
// Network error -> keep and stop this flush (the rest would fail the same way). HTTP 5xx -> keep and
// skip the rest of THAT kind (her updates stay in order), but still try the other kinds: a 5xx can be
// about one row, and must not stall "Got it" and the coach's stats behind it. Retried on start-up,
// every 5 min, on each new queued item and on quit. JS Journey dedups sessions on id, read receipts are
// idempotent and snapshots only win when newer, so re-sending after a lost response is safe.
//
// A write route answers 202 as soon as the outbox file is saved; delivery runs after the reply
// (queue()). Awaiting it made "Sending…" and "Got it" last a Vercel/Neon cold start plus the whole
// backlog (2026-10-01 review). The first feed page waits (bounded) for deliveries in flight instead, so
// the feed fetched right after a sign-off already has her new update.
//
// The feed's first page is cached in <data>/feed-<profile>.json and served (marked stale) whenever a
// fresh one can't be had, so "From Rahul" survives an offline app open. Read receipts patch that copy at
// once — otherwise an offline open would show messages she already acknowledged as new again.
//
// The token rides only in the Authorization header. The URLs we call never contain it, and log lines
// carry the profile id + HTTP status/message only — never the link.
import { rename } from 'node:fs/promises';
import path from 'node:path';
import type {
  CoachMessage,
  JourneyFeed,
  JourneySession,
  JourneyStatus,
  OutboxState,
  ProgressSnapshot,
  StudentUpdate,
} from '../shared/types.ts';
import type { ConfigStore } from './config.ts';
import { errorMessage, type Log } from './log.ts';
import { JsonFileError, KeyedMutex, readJsonFile, writeFileAtomic } from './store.ts';

const RETRY_EVERY_MS = 5 * 60 * 1000;
const MOODS = new Set(['😄', '🙂', '😐', '😩']);
/** JS Journey's cap per feed/read request: the local route takes no more, and the outbox sends in batches */
const READ_IDS_MAX = 500;
/** JS Journey's cap on an update's minutes */
const MINUTES_MAX = 1440;
/** JS Journey's message ids (and what its feed/read route insists on) */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
const isCount = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const isIsoDate = (x: unknown): boolean => typeof x === 'string' && !Number.isNaN(Date.parse(x));
const isString = (x: unknown): x is string => typeof x === 'string';
const isStringOrNull = (x: unknown): x is string | null => x === null || isString(x);
const isDay = (x: unknown): x is string => isString(x) && /^\d{4}-\d{2}-\d{2}$/.test(x);
const isLectureRef = (l: unknown): boolean => isRecord(l) && isInt(l.section, 0) && isInt(l.lecture, 0) && isString(l.title);

/** null when `x` is a ProgressSnapshot for `courseId`, else the first problem. */
export function validateProgressSnapshot(x: unknown, courseId: string): string | null {
  if (!isRecord(x)) return 'must be a ProgressSnapshot object';
  if (x.course !== courseId) return `course must be "${courseId}"`;
  if (!isCount(x.takenAt)) return 'takenAt must be epoch ms';
  for (const key of ['lecturesDone', 'lecturesTotal'] as const) {
    if (!isInt(x[key], 0)) return `${key} must be an integer >= 0`;
  }
  for (const key of ['videoSecondsDone', 'videoSecondsTotal'] as const) {
    if (!isCount(x[key])) return `${key} must be seconds >= 0`;
  }
  if (!Array.isArray(x.sectionsDone) || !x.sectionsDone.every((n: unknown) => isInt(n, 0))) return 'sectionsDone must be section numbers';
  const c = x.current;
  if (!(c === null || (isRecord(c) && isInt(c.sectionNumber, 0) && isInt(c.lectureNumber, 0) && isString(c.title)))) {
    return 'current must be {sectionNumber, lectureNumber, title} or null';
  }
  if (!isRecord(x.days) || !Object.entries(x.days).every(([day, secs]) => isDay(day) && isCount(secs))) {
    return 'days must map YYYY-MM-DD to seconds';
  }
  return null;
}

/** null when `x` is a JourneySession for `courseId`, else the first problem. */
export function validateSession(x: unknown, courseId: string): string | null {
  if (!isRecord(x)) return 'body must be a JourneySession object';
  if (!isString(x.id) || x.id.length === 0 || x.id.length > 100) return 'id must be a non-empty string';
  if (x.course !== courseId) return `course must be "${courseId}"`;
  if (!isIsoDate(x.startedAt)) return 'startedAt must be an ISO date';
  if (!isIsoDate(x.endedAt)) return 'endedAt must be an ISO date';
  if (!isDay(x.studyDate)) return 'studyDate must be YYYY-MM-DD';
  if (!isInt(x.minutes, 0) || x.minutes > MINUTES_MAX) return `minutes must be an integer from 0 to ${MINUTES_MAX}`;
  // 0 = a note-only update (she studied away from the player): without a note it says nothing.
  if (x.minutes === 0 && !(isString(x.note) && x.note.trim() !== '')) return 'minutes may be 0 only with a note';
  if (!isInt(x.sectionNumber, 1)) return 'sectionNumber must be a section number (>= 1)';
  if (!Array.isArray(x.lecturesCompleted) || !x.lecturesCompleted.every(isLectureRef)) {
    return 'lecturesCompleted must be [{section, lecture, title}]';
  }
  if (!Array.isArray(x.finishedSections) || !x.finishedSections.every((n: unknown) => isInt(n, 0))) {
    return 'finishedSections must be section numbers';
  }
  if (!(x.mood === null || (isString(x.mood) && MOODS.has(x.mood)))) return 'mood must be one of 😄 🙂 😐 😩 or null';
  if (!(x.note === null || (isString(x.note) && x.note.length <= 2000))) return 'note must be a string (<= 2000 chars) or null';
  if (typeof x.stuck !== 'boolean') return 'stuck must be a boolean';
  if (typeof x.autoClosed !== 'boolean') return 'autoClosed must be a boolean';
  if (x.progress !== null) {
    if (x.progress === undefined) return 'progress must be a ProgressSnapshot or null';
    const problem = validateProgressSnapshot(x.progress, courseId);
    if (problem !== null) return `progress: ${problem}`;
  }
  return null;
}

const isMessageId = (x: unknown): x is string => isString(x) && UUID_RE.test(x);

export type ReadIds = { ok: true; ids: string[] } | { ok: false; error: string };

/** Body of POST feed/read: `{ids}` = the coach messages she acknowledged ("Got it"), deduped. Ids are
 *  uuids like JS Journey's: one bad id there 4xx's (and so drops) the whole queued batch. */
export function parseReadIds(body: unknown): ReadIds {
  const ids = isRecord(body) ? body.ids : undefined;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > READ_IDS_MAX) {
    return { ok: false, error: `ids must be a list of 1–${READ_IDS_MAX} message ids` };
  }
  if (!ids.every(isMessageId)) return { ok: false, error: 'each id must be a message id (a uuid)' };
  return { ok: true, ids: [...new Set(ids)] };
}

/** A well-formed inclusive day range with a label (one plan break). */
function isBreakRange(x: unknown): boolean {
  return isRecord(x) && isString(x.label) && isDay(x.start) && isDay(x.end) && x.start <= x.end;
}

/** `planBreak` may be missing (a JS Journey deployed before it existed), null, or a well-formed inclusive
 *  day range. Anything else fails the whole status (→ 204), so the browser never receives a break it
 *  would mis-render. Keep in sync with shared/types.ts. */
function isPlanBreak(x: unknown): boolean {
  return x === undefined || x === null || isBreakRange(x);
}

/** The plan calendar the streak walks — missing (an older JS Journey: defaults below) or well-formed.
 *  A bad one fails the whole status, like planBreak: a garbled calendar would end her streak on a
 *  day the plan never asked her to study. */
const isStudyWeekdays = (x: unknown): boolean => x === undefined || (Array.isArray(x) && x.every((d: unknown) => isInt(d, 1) && d <= 7));
const isPlanBreaks = (x: unknown): boolean => x === undefined || (Array.isArray(x) && x.every(isBreakRange));
/** Her plan studies Mon–Fri with no breaks unless JS Journey says otherwise — also the web's default
 *  without any status (web/src/lib/stats.ts studyCalendar). */
const DEFAULT_STUDY_WEEKDAYS = [1, 2, 3, 4, 5];

/** What a deployed JS Journey may send: the fields added after v1 can still be missing (the player and
 *  JS Journey ship separately — Rahul deploys JS Journey only after his yes). */
type LaterFields = 'planBreak' | 'sectionDue' | 'skippedSections' | 'studyWeekdays' | 'planBreaks';
type WireStatus = Omit<JourneyStatus, LaterFields> & Partial<Pick<JourneyStatus, LaterFields>>;

function isWireStatus(x: unknown): x is WireStatus {
  if (!isRecord(x)) return false;
  const goalOk =
    x.goal === null || (isRecord(x.goal) && typeof x.goal.sectionNumber === 'number' && isString(x.goal.title) && isString(x.goal.due));
  const noteOk = x.coachNote === null || (isRecord(x.coachNote) && isString(x.coachNote.body) && isString(x.coachNote.createdAt));
  const dueOk =
    x.sectionDue === undefined ||
    (isRecord(x.sectionDue) && Object.entries(x.sectionDue).every(([section, day]) => /^\d+$/.test(section) && isDay(day)));
  const skippedOk = x.skippedSections === undefined || (Array.isArray(x.skippedSections) && x.skippedSections.every((n: unknown) => isInt(n, 0)));
  return (
    (x.pace === 'ahead' || x.pace === 'on-track' || x.pace === 'behind') &&
    typeof x.daysDelta === 'number' &&
    typeof x.week === 'number' &&
    typeof x.totalWeeks === 'number' &&
    isString(x.targetDate) &&
    isString(x.deadline) &&
    goalOk &&
    noteOk &&
    isPlanBreak(x.planBreak) &&
    dueOk &&
    skippedOk &&
    isStudyWeekdays(x.studyWeekdays) &&
    isPlanBreaks(x.planBreaks)
  );
}

/** The JourneyStatus with every field present (missing later fields filled: no break, no due dates,
 *  nothing skipped, Mon–Fri with no breaks), or null for a malformed body. */
export function parseJourneyStatus(x: unknown): JourneyStatus | null {
  if (!isWireStatus(x)) return null;
  return {
    ...x,
    planBreak: x.planBreak ?? null,
    sectionDue: x.sectionDue ?? {},
    skippedSections: x.skippedSections ?? [],
    studyWeekdays: x.studyWeekdays ?? [...DEFAULT_STUDY_WEEKDAYS],
    planBreaks: x.planBreaks ?? [],
  };
}

const isCoachMessage = (x: unknown): x is CoachMessage =>
  isRecord(x) && isString(x.id) && isString(x.body) && isString(x.createdAt) && isStringOrNull(x.readAt);

function isStudentUpdate(x: unknown): x is StudentUpdate {
  return (
    isRecord(x) &&
    isString(x.id) &&
    (x.source === 'player' || x.source === 'manual') &&
    isDay(x.studyDate) &&
    isString(x.createdAt) &&
    isCount(x.minutes) &&
    (x.sectionNumber === null || isInt(x.sectionNumber, 0)) &&
    isStringOrNull(x.sectionTitle) &&
    Array.isArray(x.lectures) &&
    x.lectures.every(isLectureRef) &&
    isStringOrNull(x.mood) &&
    isStringOrNull(x.note) &&
    typeof x.stuck === 'boolean' &&
    isStringOrNull(x.coachReadAt) &&
    Array.isArray(x.replies) &&
    x.replies.every(isCoachMessage)
  );
}

/** Like the status: a feed with anything unexpected is not passed on (the cached copy is served). */
export function isJourneyFeed(x: unknown): x is JourneyFeed {
  return (
    isRecord(x) &&
    Array.isArray(x.updates) &&
    x.updates.every(isStudentUpdate) &&
    Array.isArray(x.notes) &&
    x.notes.every(isCoachMessage) &&
    // first page only, and absent from a JS Journey deployed before it (contract: shared/types.ts)
    (x.unreadReplies === undefined || (Array.isArray(x.unreadReplies) && x.unreadReplies.every(isStudentUpdate))) &&
    isInt(x.unreadForStudent, 0) &&
    isStringOrNull(x.nextCursor)
  );
}

/** A coach message she acknowledged, waiting for JS Journey to confirm it. A list, not an id-keyed
 *  object: ids come from outside, and `obj["__proto__"]` is not a safe map. */
export interface ReadReceipt {
  id: string;
  at: string; // ISO, when she pressed "Got it"
}

const isReadReceipt = (x: unknown): x is ReadReceipt => isRecord(x) && isMessageId(x.id) && isString(x.at);

/** Sets readAt on the replies + notes she acknowledged and lowers the unread count to match. Returns
 *  `feed` itself when nothing changed (callers use that to skip a write). Messages outside this page
 *  cannot be counted, so the count is only lowered by what was found here, never below 0. */
export function markRead(feed: JourneyFeed, receipts: readonly ReadReceipt[]): JourneyFeed {
  const at = new Map(receipts.map((r) => [r.id, r.at]));
  let flipped = 0;
  const mark = (m: CoachMessage): CoachMessage => {
    const readAt = at.get(m.id);
    if (m.readAt !== null || readAt === undefined) return m;
    flipped++;
    return { ...m, readAt };
  };
  const updates = feed.updates.map((u) => ({ ...u, replies: u.replies.map(mark) }));
  const notes = feed.notes.map(mark);
  // replies on older updates ride in unreadReplies — unmarked there, the cached copy kept bringing them back
  const unreadReplies = feed.unreadReplies?.map((u) => ({ ...u, replies: u.replies.map(mark) }));
  if (flipped === 0) return feed;
  return { ...feed, updates, notes, ...(unreadReplies ? { unreadReplies } : {}), unreadForStudent: Math.max(0, feed.unreadForStudent - flipped) };
}

// ---- HTTP to JS Journey ------------------------------------------------------------------------

/** `retry.network`: no HTTP answer at all (the rest of the flush would fail the same way) vs an HTTP 5xx. */
type SendResult = { kind: 'sent' } | { kind: 'rejected'; message: string } | { kind: 'retry'; message: string; network: boolean };

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
  v: 2;
  /** her updates, oldest first */
  items: JourneySession[];
  /** acknowledged coach messages not yet confirmed by JS Journey (absent in a v1 file) */
  reads: ReadReceipt[];
  /** the newest snapshot not yet delivered (absent in a v1 file) */
  progress: ProgressSnapshot | null;
  lastError: string | null;
}

/** `pending` counts her updates only: receipts and the snapshot ride along without a badge. */
const view = (o: OutboxFile): OutboxState => ({ pending: o.items.length, lastError: o.lastError });
const hasWork = (o: OutboxFile): boolean => o.items.length > 0 || o.reads.length > 0 || o.progress !== null;
const emptyOutbox = (): OutboxFile => ({ v: 2, items: [], reads: [], progress: null, lastError: null });

/** One delivery a flush makes; `remove` takes it out of the outbox once JS Journey answered for good.
 *  It is applied to the outbox as it is AFTER the requests (re-read under the lock: items may have been
 *  queued meanwhile), so it removes exactly what was delivered and nothing queued since. */
interface Job {
  kind: 'session' | 'reads' | 'progress';
  what: string;
  method: 'POST' | 'PUT';
  route: string;
  body: unknown;
  remove: (outbox: OutboxFile) => void;
}

function jobsFor(outbox: OutboxFile): Job[] {
  const jobs: Job[] = outbox.items.map((session) => {
    const sent = JSON.stringify(session);
    return {
      kind: 'session',
      what: `session ${session.id}`,
      method: 'POST',
      route: '/api/player/sessions',
      body: session,
      // a re-posted id replaced while this one was in flight is a different body: it stays queued
      remove: (o) => {
        o.items = o.items.filter((s) => JSON.stringify(s) !== sent);
      },
    };
  });
  // In batches: receipts pile up while offline, and JS Journey 400s more than READ_IDS_MAX per request.
  for (let i = 0; i < outbox.reads.length; i += READ_IDS_MAX) {
    const ids = outbox.reads.slice(i, i + READ_IDS_MAX).map((r) => r.id);
    const batch = new Set(ids);
    jobs.push({
      kind: 'reads',
      what: `${ids.length} read receipt(s)`,
      method: 'POST',
      route: '/api/player/feed/read',
      body: { ids },
      remove: (o) => {
        o.reads = o.reads.filter((r) => !batch.has(r.id));
      },
    });
  }
  const snap = outbox.progress;
  if (snap !== null) {
    jobs.push({
      kind: 'progress',
      what: 'progress snapshot',
      method: 'PUT',
      route: '/api/player/progress',
      body: snap,
      remove: (o) => {
        if (o.progress !== null && o.progress.takenAt <= snap.takenAt) o.progress = null; // a newer one stays
      },
    });
  }
  return jobs;
}

export interface JourneyOptions {
  dataDir: string;
  config: ConfigStore;
  /** Course.id — the `course` JS Journey files sessions/status/feed under */
  courseId: string;
  log: Log;
  /** per-request timeout; 5 s in production */
  timeoutMs?: number;
}

export type LinkCheck = { ok: true; link: string } | { ok: false; status: 400 | 502; message: string };

/** A feed for the browser; `stale` = the cached copy, because a fresh one could not be had. */
export interface FeedResult {
  feed: JourneyFeed;
  stale: boolean;
}

type FeedFetch = { ok: true; feed: JourneyFeed } | { ok: false; why: string };

export class Journey {
  /** outbox file read-modify-write, per profile. Held only around the file — NEVER across a request to
   *  JS Journey: a write route waiting behind a slow delivery is what made the 202 slow (2026-10-01). */
  private readonly locks = new KeyedMutex();
  /** one flush at a time per profile (a second would only resend the same items) */
  private readonly flushLocks = new KeyedMutex();
  /** feed cache read-modify-write, per profile — separate so a slow flush never delays her feed */
  private readonly feedLocks = new KeyedMutex();
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
    if (raw === undefined) return emptyOutbox();
    if (!isRecord(raw) || !Array.isArray(raw.items) || !(raw.lastError === null || isString(raw.lastError))) {
      return this.moveAside(profile, file);
    }
    const reads: unknown = raw.reads ?? [];
    const progress: unknown = raw.progress ?? null;
    if (!Array.isArray(reads) || !reads.every(isReadReceipt) || !(progress === null || isRecord(progress))) {
      return this.moveAside(profile, file);
    }
    // items + progress were validated before they were queued; the shapes are checked above
    return { v: 2, items: raw.items as JourneySession[], reads, progress: progress as ProgressSnapshot | null, lastError: raw.lastError };
  }

  /** Never silently lose pending deliveries: keep the unreadable file for inspection, start empty. */
  private async moveAside(profile: string, file: string): Promise<OutboxFile> {
    await rename(file, `${file}.corrupt`);
    this.opts.log(`[journey] ${profile}: ${path.basename(file)} is unreadable — moved aside to ${path.basename(file)}.corrupt`);
    return emptyOutbox();
  }

  private save(profile: string, outbox: OutboxFile): Promise<void> {
    return writeFileAtomic(this.file(profile), JSON.stringify(outbox));
  }

  /** Lock-free look at the receipts still queued (writes are atomic renames, so this sees a whole file).
   *  An unreadable outbox counts as none here; the next flush moves it aside and logs it. */
  private async queuedReads(profile: string): Promise<ReadReceipt[]> {
    let raw: unknown;
    try {
      raw = await readJsonFile(this.file(profile));
    } catch (err) {
      if (err instanceof JsonFileError) return [];
      throw err;
    }
    return isRecord(raw) && Array.isArray(raw.reads) ? raw.reads.filter(isReadReceipt) : [];
  }

  private async send(link: StudentLink, job: Job, timeoutMs: number): Promise<SendResult> {
    let res: Response;
    try {
      res = await fetch(`${link.origin}${job.route}`, {
        method: job.method,
        headers: { authorization: `Bearer ${link.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(job.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      return { kind: 'retry', message: networkMessage(err), network: true };
    }
    if (res.ok) {
      await res.body?.cancel();
      return { kind: 'sent' };
    }
    const message = `HTTP ${res.status} — ${await describeFailure(res)}`;
    return res.status >= 400 && res.status < 500 ? { kind: 'rejected', message } : { kind: 'retry', message, network: false };
  }

  outbox(profile: string): Promise<OutboxState> {
    return this.locks.run(profile, async () => view(await this.load(profile)));
  }

  /** Applies `change` to the outbox (saved when it says so) and returns the outbox as saved. null = not
   *  connected, nothing written. */
  private async record(profile: string, change: (outbox: OutboxFile) => boolean): Promise<OutboxState | null> {
    if (!this.linkFor(profile)) return null;
    return this.locks.run(profile, async () => {
      const outbox = await this.load(profile);
      if (change(outbox)) await this.save(profile, outbox);
      return view(outbox);
    });
  }

  /** Records `change` and answers with the outbox as saved (the item counted as pending); delivery
   *  starts in the background. Do NOT await the flush here — see the header (2026-10-01 review). */
  private async queue(profile: string, change: (outbox: OutboxFile) => boolean): Promise<OutboxState | null> {
    const saved = await this.record(profile, change);
    if (saved !== null) this.deliverSoon(profile);
    return saved;
  }

  /** A background flush (queued behind any flush in flight; settled() after this sees its result). */
  private deliverSoon(profile: string): void {
    this.flush(profile).catch((err: unknown) => {
      this.opts.log(`[journey] ${profile}: delivery failed — ${errorMessage(err)}`);
    });
  }

  /** The outbox once every delivery started before this call has settled (the feed waits on it; tests
   *  use it to see what a write's background delivery did). */
  settled(profile: string): Promise<OutboxState> {
    return this.flushLocks.run(profile, () => this.outbox(profile));
  }

  /** settled(), but never longer than `ms`: a hung JS Journey must not hang her feed. */
  private async deliveriesSettled(profile: string, ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const cap = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    });
    try {
      await Promise.race([this.settled(profile), cap]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Queues a validated session (a re-sent id replaces the queued one) and tries to deliver it now. */
  enqueue(profile: string, session: JourneySession): Promise<OutboxState | null> {
    return this.queue(profile, (outbox) => {
      const i = outbox.items.findIndex((s) => s.id === session.id);
      if (i >= 0) outbox.items[i] = session;
      else outbox.items.push(session);
      return true;
    });
  }

  /** Queues read receipts (ids already queued keep their time), marks them read in the cached feed, and
   *  starts delivering them. Outbox first: a feed fetched meanwhile then already sees them queued. The
   *  cached feed is patched BEFORE the reply (an offline open right after must not show them as new). */
  async enqueueReads(profile: string, ids: readonly string[]): Promise<OutboxState | null> {
    const at = new Date().toISOString();
    const receipts = ids.map((id) => ({ id, at }));
    const saved = await this.record(profile, (outbox) => {
      const queued = new Set(outbox.reads.map((r) => r.id));
      const fresh = receipts.filter((r) => !queued.has(r.id));
      outbox.reads.push(...fresh);
      return fresh.length > 0;
    });
    if (saved === null) return null;
    await this.patchCachedFeed(profile, receipts);
    this.deliverSoon(profile);
    return saved;
  }

  /** Queues a validated snapshot unless an equally new or newer one is already queued; tries to deliver. */
  enqueueProgress(profile: string, snap: ProgressSnapshot): Promise<OutboxState | null> {
    return this.queue(profile, (outbox) => {
      if (outbox.progress !== null && outbox.progress.takenAt >= snap.takenAt) return false;
      outbox.progress = snap;
      return true;
    });
  }

  /** Delivers the outbox in order until done, a transient failure, or `deadline` (epoch ms). */
  flush(profile: string, deadline = Number.POSITIVE_INFINITY): Promise<OutboxState> {
    return this.flushLocks.run(profile, async () => {
      const queued = await this.locks.run(profile, () => this.load(profile));
      const link = this.linkFor(profile);
      if (!link || !hasWork(queued)) return view(queued);
      const { log } = this.opts;
      const sent = { session: 0, reads: 0, progress: 0 };
      const done: Job[] = [];
      const delivered: ReadReceipt[] = [];
      const held = new Set<Job['kind']>(); // a kind that got a 5xx this flush: the rest of it waits
      let attempted = false;
      let error: string | null = null;
      // The requests run WITHOUT the outbox lock (see `locks`); results are applied under it below.
      for (const job of jobsFor(queued)) {
        if (held.has(job.kind)) continue;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        attempted = true;
        const result = await this.send(link, job, Math.min(this.timeoutMs, remaining));
        if (result.kind === 'retry') {
          error = result.message;
          log(`[journey] ${profile}: ${result.message} (${job.what} kept), ${queued.items.length} pending`);
          // No answer at all: everything else would fail the same way. A 5xx may be about this one item
          // (an insert error on that row): keep it, and still deliver the other kinds behind it.
          if (result.network) break;
          held.add(job.kind);
          continue;
        }
        done.push(job);
        if (result.kind === 'sent') {
          sent[job.kind]++;
          if (job.kind === 'reads') delivered.push(...queued.reads.filter((r) => (job.body as { ids: string[] }).ids.includes(r.id)));
        } else {
          error = result.message;
          log(`[journey] ${profile}: ${result.message} (${job.what} dropped)`);
        }
      }
      if (!attempted) return view(queued);
      const state = await this.locks.run(profile, async () => {
        const outbox = await this.load(profile);
        for (const job of done) job.remove(outbox);
        // lastError describes the latest flush: a fully delivered flush clears it.
        outbox.lastError = error;
        await this.save(profile, outbox);
        return view(outbox);
      });
      if (sent.session > 0) log(`[journey] ${profile}: sent ${sent.session}, ${state.pending} pending`);
      if (sent.reads > 0) {
        log(`[journey] ${profile}: ${delivered.length} read receipt(s) delivered`);
        // A fresh feed cached between "Got it" and now may predate the receipts: once they leave the
        // outbox nothing else would mark them read in the copy an offline app open is served.
        await this.patchCachedFeed(profile, delivered);
      }
      return state;
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

  // ---- feed ------------------------------------------------------------------------------------

  /** A fresh page (the first one, `cursor` null, is cached), else the cached first page marked stale,
   *  else null. Queued read receipts are applied either way: JS Journey may not have them yet. */
  async feed(profile: string, cursor: string | null): Promise<FeedResult | null> {
    const link = this.linkFor(profile);
    const firstPage = cursor === null;
    let failure: string | null = null; // why a fresh page could not be had; null = not connected
    if (link) {
      // The browser refreshes the feed right after a sign-off, and the 202 no longer waits for delivery:
      // let a delivery in flight land first (bounded), or her new update is missing from "Your updates".
      if (firstPage) await this.deliveriesSettled(profile, this.timeoutMs);
      const fetched = await this.fetchFeed(link, cursor);
      if (fetched.ok) {
        const shown = markRead(fetched.feed, await this.queuedReads(profile));
        if (firstPage) await this.cacheFeed(profile, shown);
        return { feed: shown, stale: false };
      }
      failure = fetched.why;
    }
    const cached = firstPage ? await this.cachedFeed(profile) : null;
    if (failure !== null) {
      const fallback = !firstPage ? 'later pages are not cached' : cached !== null ? 'serving the cached copy' : 'nothing cached yet';
      this.opts.log(`[journey] ${profile}: feed ${failure} (${fallback})`);
    }
    return cached === null ? null : { feed: markRead(cached, await this.queuedReads(profile)), stale: true };
  }

  private async fetchFeed(link: StudentLink, cursor: string | null): Promise<FeedFetch> {
    const query = `course=${encodeURIComponent(this.opts.courseId)}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
    let res: Response;
    try {
      res = await fetch(`${link.origin}/api/player/feed?${query}`, {
        headers: { authorization: `Bearer ${link.token}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      return { ok: false, why: networkMessage(err) };
    }
    if (!res.ok) return { ok: false, why: `HTTP ${res.status} — ${await describeFailure(res)}` };
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      return { ok: false, why: `body is not JSON — ${errorMessage(err)}` };
    }
    return isJourneyFeed(body) ? { ok: true, feed: body } : { ok: false, why: 'body has an unexpected shape' };
  }

  private feedFile(profile: string): string {
    return path.join(this.opts.dataDir, `feed-${profile}.json`);
  }

  /** The cached first page, or null when there is none. An unreadable copy is logged and ignored (it is
   *  only a cache: the next good feed overwrites it — no .corrupt file on the exFAT SSD). */
  private async cachedFeed(profile: string): Promise<JourneyFeed | null> {
    const file = this.feedFile(profile);
    let raw: unknown;
    try {
      raw = await readJsonFile(file);
    } catch (err) {
      if (!(err instanceof JsonFileError)) throw err;
      raw = null;
    }
    if (raw === undefined) return null;
    if (isRecord(raw) && isJourneyFeed(raw.feed)) return raw.feed;
    this.opts.log(`[journey] ${profile}: ${path.basename(file)} is unreadable — ignored until the next good feed`);
    return null;
  }

  /** Writes only when the page changed: every write is a new .tmp file on the exFAT SSD. A failed cache
   *  write is logged and the fresh feed still served. */
  private cacheFeed(profile: string, feed: JourneyFeed): Promise<void> {
    return this.feedLocks.run(profile, async () => {
      try {
        const cached = await this.cachedFeed(profile);
        if (cached !== null && JSON.stringify(cached) === JSON.stringify(feed)) return;
        await writeFileAtomic(this.feedFile(profile), JSON.stringify({ v: 1, feed }));
      } catch (err) {
        this.opts.log(`[journey] ${profile}: could not cache the feed — ${errorMessage(err)}`);
      }
    });
  }

  /** Marks `receipts` read in the cached first page. Like cacheFeed, a failure is logged, never thrown. */
  private patchCachedFeed(profile: string, receipts: readonly ReadReceipt[]): Promise<void> {
    return this.feedLocks.run(profile, async () => {
      try {
        const cached = await this.cachedFeed(profile);
        if (cached === null) return;
        const patched = markRead(cached, receipts);
        if (patched !== cached) await writeFileAtomic(this.feedFile(profile), JSON.stringify({ v: 1, feed: patched }));
      } catch (err) {
        this.opts.log(`[journey] ${profile}: could not mark the cached feed read — ${errorMessage(err)}`);
      }
    });
  }

  // ---- status + link check ---------------------------------------------------------------------

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
    const status = parseJourneyStatus(body);
    if (status === null) log(`[journey] ${profile}: status body has an unexpected shape`);
    return status;
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

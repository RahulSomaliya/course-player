// JS Journey bridge (Mansi's study tracker; Rahul coaches her there): status proxy, student-link check,
// the coach feed with its last good copy, and the outbox <data>/outbox-<profile>.json
// (docs/spec.md §2 "Outbox -> JS Journey", docs/spec-v2-coaching.md).
//
// The outbox holds everything the player owes JS Journey: her updates (sessions, oldest first), the
// read receipts for coach messages she acknowledged, and the newest progress snapshot (latest wins on
// takenAt). A flush sends them in that order. Delivery rules:
// - 2xx -> delivered, out of the queue. An update leaves a receipt (the last DELIVERED_KEEP), so the
//   browser can say "Sent to Rahul ✓" instead of "the local server queued it".
// - 4xx -> not retried on its own (a permanent rejection must not retry forever); message in lastError.
//   Her UPDATE is kept as `rejected` — NEVER dropped (v3). v2 deleted it: on 2026-10-05 her copy's course
//   id was wrong, JS Journey 4xx'd her sign-off and it was gone for good. Rejected updates are re-queued
//   once on every server start, on (re)connect and on "Try again" (retry()) — a fixed course id or a JS
//   Journey fix then lets them through. Read receipts and snapshots ARE dropped (no words of hers; the
//   next snapshot supersedes). Validation here stays at least as strict as JS Journey's (lib/player.ts
//   there): an item it would 400 is refused to the browser up front, never queued to be rejected later.
// - Network error -> keep and stop this flush (the rest would fail the same way). HTTP 5xx -> keep and
//   skip the rest of THAT kind (her updates stay in order), but still try the other kinds: a 5xx can be
//   about one row, and must not stall "Got it" and the coach's stats behind it.
// Retried on start-up, every 5 min, on each new queued item and on quit. JS Journey dedups sessions on id,
// read receipts are idempotent and snapshots only win when newer, so re-sending after a lost response is
// safe. Updates are accepted while NOT connected (v3): they wait here and go out once she connects. Every
// update and snapshot goes out under THIS copy's course id (opts.courseId), whatever it was queued with —
// one queued under a guessed folder id would otherwise be rejected again after the id is fixed.
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
  JourneyProblem,
  JourneySession,
  JourneyStatus,
  OutboxState,
  OutboxUpdate,
  PlanRow,
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
/** delivery receipts kept in the outbox (the browser's "Sent to Rahul ✓" + recent history) */
const DELIVERED_KEEP = 50;
/** the most a GET outbox?wait= may hold the request (the sign-off card asks for ~8 s) */
export const OUTBOX_WAIT_MAX_MS = 10_000;
/** JourneySession.id is 1–100 chars (validateSession) */
const SESSION_ID_MAX = 100;
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

export type RetryIds = { ok: true; ids: string[] | undefined } | { ok: false; error: string };

/** Body of POST outbox/retry: absent / `{}` = every rejected update, `{ids}` = those updates only. */
export function parseRetryIds(body: unknown): RetryIds {
  if (body === undefined) return { ok: true, ids: undefined };
  if (!isRecord(body)) return { ok: false, error: 'body must be {} or { ids: [...] }' };
  if (body.ids === undefined) return { ok: true, ids: undefined };
  const ids = body.ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > READ_IDS_MAX) return { ok: false, error: `ids must be a list of 1–${READ_IDS_MAX} update ids` };
  if (!ids.every((id: unknown) => isString(id) && id.length > 0 && id.length <= SESSION_ID_MAX)) return { ok: false, error: 'each id must be an update id' };
  return { ok: true, ids: [...new Set(ids as string[])] };
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

const PLAN_STATES = new Set(['done', 'current', 'behind', 'upcoming', 'past']);
const isPlanRow = (x: unknown): x is PlanRow =>
  isRecord(x) &&
  ((x.kind === 'week' && isInt(x.week, 0) && isDay(x.due) && isString(x.goal) && isString(x.state) && PLAN_STATES.has(x.state)) ||
    (x.kind === 'break' && isString(x.label) && isDay(x.start) && isDay(x.end) && typeof x.now === 'boolean'));
const isPlan = (x: unknown): x is PlanRow[] => Array.isArray(x) && x.every(isPlanRow);

/** The JourneyStatus with every field present (missing later fields filled: no break, no due dates,
 *  nothing skipped, Mon–Fri with no breaks), or null for a malformed body. `plan` (v3) is the exception:
 *  optional, and a malformed one is left OUT rather than failing the status — it is display-only, and a
 *  new row state on JS Journey's side must not take "This week", Due and the streak calendar down with it.
 *  status() logs the drop. */
export function parseJourneyStatus(x: unknown): JourneyStatus | null {
  if (!isWireStatus(x)) return null;
  const { plan, ...rest } = x;
  return {
    ...rest,
    planBreak: x.planBreak ?? null,
    sectionDue: x.sectionDue ?? {},
    skippedSections: x.skippedSections ?? [],
    studyWeekdays: x.studyWeekdays ?? [...DEFAULT_STUDY_WEEKDAYS],
    planBreaks: x.planBreaks ?? [],
    ...(isPlan(plan) ? { plan } : {}),
  };
}

/** JS Journey's answer for a course id it does not know: 404 `{ error: 'unknown course "<id>"' }` from
 *  GET /api/player/status and /feed (js-journey app/api/player/status/route.ts, lib/feed.ts
 *  parseFeedQuery). Matched on the message too: a bare 404 (wrong host, an old deploy) is not the
 *  course's fault. If JS Journey rewords it, this turns back into a silent "none" — keep them in sync. */
const isUnknownCourse = (status: number, why: string): boolean => status === 404 && /unknown course/i.test(why);

export function unknownCourseProblem(courseId: string): JourneyProblem {
  return {
    error: `JS Journey doesn't know the course '${courseId}' — this copy's course id is wrong; ask Rahul.`,
    problem: 'unknown-course',
    courseId,
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

/** An update JS Journey answered 4xx — kept until re-queued, never dropped (v3). */
interface RejectedUpdate {
  session: JourneySession;
  /** "HTTP 400 — <JS Journey's message>" */
  error: string;
  at: string; // ISO, when JS Journey refused it
}

/** Proof an update reached JS Journey (2xx). */
interface DeliveredReceipt {
  id: string;
  at: string; // ISO
}

/** <data>/outbox-<profile>.json. v1 had items + lastError, v2 added reads + progress, v3 adds rejected +
 *  delivered: every older file loads as is (her Mac has a v2 one), the next save writes v3. */
interface OutboxFile {
  v: 3;
  /** her updates still to deliver, oldest first */
  items: JourneySession[];
  /** her updates JS Journey refused, oldest first (absent before v3) */
  rejected: RejectedUpdate[];
  /** the last DELIVERED_KEEP delivery receipts, oldest first, one per id (absent before v3) */
  delivered: DeliveredReceipt[];
  /** acknowledged coach messages not yet confirmed by JS Journey (absent in a v1 file) */
  reads: ReadReceipt[];
  /** the newest snapshot not yet delivered (absent in a v1 file) */
  progress: ProgressSnapshot | null;
  lastError: string | null;
}

/** Enough to list it and send it again; the full shape was validated when it was queued. */
const isQueuedSession = (x: unknown): x is JourneySession => isRecord(x) && isString(x.id) && isString(x.endedAt);
const isRejectedUpdate = (x: unknown): x is RejectedUpdate => isRecord(x) && isQueuedSession(x.session) && isString(x.error) && isString(x.at);
const isDeliveredReceipt = (x: unknown): x is DeliveredReceipt => isRecord(x) && isString(x.id) && isString(x.at);

/** `pending` counts her queued updates only: receipts and the snapshot ride along without a badge, and a
 *  rejected update waits for a retry, not for the next flush. `updates`: one entry per id (queued beats
 *  rejected beats delivered), newest `at` first — shared/types.ts OutboxUpdate. */
function view(o: OutboxFile): OutboxState {
  const listed = new Set<string>();
  const updates: OutboxUpdate[] = [];
  for (const session of o.items) {
    listed.add(session.id);
    updates.push({ id: session.id, state: 'queued', at: session.endedAt, error: null, session });
  }
  for (const r of o.rejected) {
    if (listed.has(r.session.id)) continue;
    listed.add(r.session.id);
    updates.push({ id: r.session.id, state: 'rejected', at: r.at, error: r.error, session: r.session });
  }
  for (const d of o.delivered) {
    if (!listed.has(d.id)) updates.push({ id: d.id, state: 'delivered', at: d.at, error: null });
  }
  updates.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { pending: o.items.length, lastError: o.lastError, updates };
}
const hasWork = (o: OutboxFile): boolean => o.items.length > 0 || o.reads.length > 0 || o.progress !== null;
const emptyOutbox = (): OutboxFile => ({ v: 3, items: [], rejected: [], delivered: [], reads: [], progress: null, lastError: null });

function recordDelivered(o: OutboxFile, id: string, at: string): void {
  o.rejected = o.rejected.filter((r) => r.session.id !== id);
  o.delivered = [...o.delivered.filter((d) => d.id !== id), { id, at }].slice(-DELIVERED_KEEP);
}

function recordRejected(o: OutboxFile, session: JourneySession, error: string, at: string): void {
  o.rejected = [...o.rejected.filter((r) => r.session.id !== session.id), { session, error, at }];
}

/** `session` as THIS copy's course sends it (see the header: an update queued under a guessed id). */
function forCourse(session: JourneySession, courseId: string): JourneySession {
  if (session.course === courseId && (session.progress === null || session.progress.course === courseId)) return session;
  return { ...session, course: courseId, progress: session.progress === null ? null : { ...session.progress, course: courseId } };
}

/** What JS Journey answered for good: delivered, or refused (4xx). */
type Outcome = { kind: 'sent' } | { kind: 'rejected'; message: string };

/** One delivery a flush makes; `settle` records JS Journey's final answer in the outbox. It is applied
 *  to the outbox as it is AFTER the requests (re-read under the lock: items may have been queued
 *  meanwhile), so it settles exactly what was sent and nothing queued since. */
interface Job {
  kind: 'session' | 'reads' | 'progress';
  what: string;
  method: 'POST' | 'PUT';
  route: string;
  body: unknown;
  /** logged before sending: the item was queued under another course id and goes out under this one */
  relabelled: string | null;
  settle: (outbox: OutboxFile, outcome: Outcome, at: string) => void;
}

const relabel = (what: string, from: string, to: string): string | null => (from === to ? null : `${what} was queued for course "${from}" — sent as "${to}"`);

function jobsFor(outbox: OutboxFile, courseId: string): Job[] {
  const jobs: Job[] = outbox.items.map((session) => {
    const sent = JSON.stringify(session);
    return {
      kind: 'session',
      what: `session ${session.id}`,
      method: 'POST',
      route: '/api/player/sessions',
      body: forCourse(session, courseId),
      relabelled: relabel(`session ${session.id}`, session.course, courseId),
      // a re-posted id replaced while this one was in flight is a different body: it stays queued (and a
      // refusal of the old body is not recorded — the new one may well go through)
      settle: (o, outcome, at) => {
        const before = o.items.length;
        o.items = o.items.filter((s) => JSON.stringify(s) !== sent);
        if (outcome.kind === 'sent') recordDelivered(o, session.id, at);
        else if (o.items.length < before) recordRejected(o, session, outcome.message, at);
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
      relabelled: null,
      settle: (o) => {
        o.reads = o.reads.filter((r) => !batch.has(r.id)); // delivered or refused: gone either way
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
      body: { ...snap, course: courseId },
      relabelled: relabel('progress snapshot', snap.course, courseId),
      settle: (o) => {
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

export type LinkCheck =
  | { ok: true; link: string }
  | { ok: false; status: 400 | 502; message: string }
  /** the link works but JS Journey does not know this copy's course id (v3) */
  | { ok: false; status: 409; message: string; problem: JourneyProblem };

/** GET status, as the status route answers it: 200 / 204 / 409 (shared/types.ts route list). */
export type StatusResult = { kind: 'status'; status: JourneyStatus } | { kind: 'none' } | { kind: 'problem'; problem: JourneyProblem };

/** Why rejected updates went back into the queue (logged). */
export type RequeueReason = 'try again' | 'connected' | 'server start';

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
    if (!isRecord(raw) || !Array.isArray(raw.items) || !raw.items.every(isQueuedSession) || !(raw.lastError === null || isString(raw.lastError))) {
      return this.moveAside(profile, file);
    }
    // fields added by v2 (reads, progress) and v3 (rejected, delivered) are absent from older files
    const reads: unknown = raw.reads ?? [];
    const progress: unknown = raw.progress ?? null;
    const rejected: unknown = raw.rejected ?? [];
    const delivered: unknown = raw.delivered ?? [];
    if (
      !Array.isArray(reads) ||
      !reads.every(isReadReceipt) ||
      !(progress === null || isRecord(progress)) ||
      !Array.isArray(rejected) ||
      !rejected.every(isRejectedUpdate) ||
      !Array.isArray(delivered) ||
      !delivered.every(isDeliveredReceipt)
    ) {
      return this.moveAside(profile, file);
    }
    // items + progress were validated before they were queued; the shapes are checked above
    return { v: 3, items: raw.items, rejected, delivered, reads, progress: progress as ProgressSnapshot | null, lastError: raw.lastError };
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

  /** The outbox; with `waitMs`, once the deliveries in flight have settled (never longer than that): the
   *  sign-off card POSTs her update, then asks with a wait whether it was delivered, is still queued or
   *  was rejected — one round trip, and the 202 itself never waits for JS Journey. */
  async outbox(profile: string, waitMs = 0): Promise<OutboxState> {
    if (waitMs > 0) await this.deliveriesSettled(profile, waitMs);
    return this.locks.run(profile, async () => view(await this.load(profile)));
  }

  /** Applies `change` to the outbox (saved when it says so) and returns the outbox as saved. */
  private change(profile: string, change: (outbox: OutboxFile) => boolean): Promise<OutboxState> {
    return this.locks.run(profile, async () => {
      const outbox = await this.load(profile);
      if (change(outbox)) await this.save(profile, outbox);
      return view(outbox);
    });
  }

  /** change(), only for a connected profile (read receipts + snapshots). null = not connected, nothing
   *  written. Her updates do NOT go through here: they are kept while not connected (v3). */
  private async record(profile: string, change: (outbox: OutboxFile) => boolean): Promise<OutboxState | null> {
    if (!this.linkFor(profile)) return null;
    return this.change(profile, change);
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

  /** Queues a validated session — connected or not (v3: an update is never turned away; it goes out once
   *  she connects) — and answers with the outbox as saved; delivery starts in the background. Do NOT await
   *  the flush here (see the header, 2026-10-01 review). A re-sent id replaces the queued one, and takes a
   *  rejected one back into the queue ("Try again" with her edited note). */
  async enqueue(profile: string, session: JourneySession): Promise<OutboxState> {
    const saved = await this.change(profile, (outbox) => {
      outbox.rejected = outbox.rejected.filter((r) => r.session.id !== session.id);
      const i = outbox.items.findIndex((s) => s.id === session.id);
      if (i >= 0) outbox.items[i] = session;
      else outbox.items.push(session);
      return true;
    });
    this.deliverSoon(profile);
    return saved;
  }

  /** "Try again" (and (re)connect): re-queues the rejected updates — all, or those `ids` — and starts a
   *  delivery in the background. Answers with the outbox as saved. */
  async retry(profile: string, ids?: readonly string[], why: RequeueReason = 'try again'): Promise<OutboxState> {
    const saved = await this.requeue(profile, ids, why);
    this.deliverSoon(profile);
    return saved;
  }

  /** Moves rejected updates back to the FRONT of the queue (they are older than what was queued since).
   *  Writes nothing when there are none — no new outbox file for a profile that never had one. */
  private async requeue(profile: string, ids: readonly string[] | undefined, why: RequeueReason): Promise<OutboxState> {
    const picked = (r: RejectedUpdate): boolean => ids === undefined || ids.includes(r.session.id);
    let moved = 0;
    const saved = await this.change(profile, (outbox) => {
      const back = outbox.rejected.filter(picked);
      if (back.length === 0) return false;
      const queued = new Set(outbox.items.map((s) => s.id));
      outbox.rejected = outbox.rejected.filter((r) => !picked(r));
      outbox.items = [...back.map((r) => r.session).filter((s) => !queued.has(s.id)), ...outbox.items];
      moved = back.length;
      return true;
    });
    if (moved > 0) this.opts.log(`[journey] ${profile}: ${moved} rejected update(s) re-queued (${why})`);
    return saved;
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

  /** Queues a validated snapshot unless an equally new or newer one is already queued; tries to deliver.
   *  null = not connected (nothing written): the browser only pushes snapshots while connected. */
  async enqueueProgress(profile: string, snap: ProgressSnapshot): Promise<OutboxState | null> {
    const saved = await this.record(profile, (outbox) => {
      if (outbox.progress !== null && outbox.progress.takenAt >= snap.takenAt) return false;
      outbox.progress = snap;
      return true;
    });
    if (saved !== null) this.deliverSoon(profile);
    return saved;
  }

  /** Delivers the outbox in order until done, a transient failure, or `deadline` (epoch ms). */
  flush(profile: string, deadline = Number.POSITIVE_INFINITY): Promise<OutboxState> {
    return this.flushLocks.run(profile, async () => {
      const queued = await this.locks.run(profile, () => this.load(profile));
      const link = this.linkFor(profile);
      if (!link || !hasWork(queued)) return view(queued);
      const { log } = this.opts;
      const sent = { session: 0, reads: 0, progress: 0 };
      const done: { job: Job; outcome: Outcome; at: string }[] = [];
      const delivered: ReadReceipt[] = [];
      const held = new Set<Job['kind']>(); // a kind that got a 5xx this flush: the rest of it waits
      let attempted = false;
      let error: string | null = null;
      // The requests run WITHOUT the outbox lock (see `locks`); results are applied under it below.
      for (const job of jobsFor(queued, this.opts.courseId)) {
        if (held.has(job.kind)) continue;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        attempted = true;
        if (job.relabelled !== null) log(`[journey] ${profile}: ${job.relabelled}`);
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
        done.push({ job, outcome: result, at: new Date().toISOString() });
        if (result.kind === 'sent') {
          sent[job.kind]++;
          if (job.kind === 'reads') delivered.push(...queued.reads.filter((r) => (job.body as { ids: string[] }).ids.includes(r.id)));
        } else {
          error = result.message;
          log(`[journey] ${profile}: ${result.message} (${job.what} ${job.kind === 'session' ? 'kept as rejected' : 'dropped'})`);
        }
      }
      if (!attempted) return view(queued);
      const state = await this.locks.run(profile, async () => {
        const outbox = await this.load(profile);
        for (const { job, outcome, at } of done) job.settle(outbox, outcome, at);
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

  /** Start-up: re-queue every profile's rejected updates ONCE (a fixed course id or JS Journey fix lets
   *  them through), then flush; afterwards retry every 5 min. The timer never keeps the process alive.
   *  Resolves when the start-up delivery is done (main ignores it; tests await it). */
  start(): Promise<void> {
    const run = (): void => {
      this.flushAll(this.timeoutMs * 2).catch((err: unknown) => {
        this.opts.log(`[journey] retry failed: ${errorMessage(err)}`);
      });
    };
    this.timer = setInterval(run, RETRY_EVERY_MS);
    this.timer.unref();
    return (async () => {
      for (const p of this.opts.config.profiles()) await this.requeue(p.id, undefined, 'server start');
      await this.flushAll(this.timeoutMs * 2);
    })().catch((err: unknown) => {
      this.opts.log(`[journey] start-up delivery failed: ${errorMessage(err)}`);
    });
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

  /** GET <origin>/api/player/status?course=<id>. `problem` when JS Journey does not know the course (v3:
   *  shown to her, never a silent 204 — 2026-10-05); `none` when not connected, unreachable, any other
   *  non-2xx, or malformed. */
  async status(profile: string): Promise<StatusResult> {
    const none: StatusResult = { kind: 'none' };
    const link = this.linkFor(profile);
    if (!link) return none;
    const { log } = this.opts;
    let res: Response;
    try {
      res = await this.getStatus(link);
    } catch (err) {
      log(`[journey] ${profile}: status ${networkMessage(err)}`);
      return none;
    }
    if (!res.ok) {
      const why = await describeFailure(res);
      log(`[journey] ${profile}: status HTTP ${res.status} — ${why}`);
      return isUnknownCourse(res.status, why) ? { kind: 'problem', problem: unknownCourseProblem(this.opts.courseId) } : none;
    }
    if (res.status === 204) {
      await res.body?.cancel();
      return none;
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      log(`[journey] ${profile}: status body is not JSON — ${errorMessage(err)}`);
      return none;
    }
    const status = parseJourneyStatus(body);
    if (status === null) {
      log(`[journey] ${profile}: status body has an unexpected shape`);
      return none;
    }
    if (isRecord(body) && body.plan !== undefined && status.plan === undefined) log(`[journey] ${profile}: status plan has an unexpected shape — dropped`);
    return { kind: 'status', status };
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
      if (isUnknownCourse(res.status, why)) {
        const problem = unknownCourseProblem(this.opts.courseId);
        return { ok: false, status: 409, message: problem.error, problem };
      }
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

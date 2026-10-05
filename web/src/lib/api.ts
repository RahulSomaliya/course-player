// The only module that talks to the course server. Every non-GET /api call carries
// `x-course-player: 1` — the server's CSRF rule (server/app.ts) answers 403 without it, and that
// includes the keepalive PUT on pagehide. Errors carry the server's `{error}` message, and a 409 from the
// JS Journey routes its typed JourneyProblem (`ApiError.problem`). Route list: shared/types.ts.
import type {
  BootPayload,
  JourneyFeed,
  JourneyProblem,
  JourneySession,
  JourneyStatus,
  OutboxState,
  Profile,
  ProgressSnapshot,
} from '../../../shared/types';

const WRITE_HEADERS = { 'content-type': 'application/json', 'x-course-player': '1' } as const;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** set when the server answered 409 with a JourneyProblem (v3: JS Journey does not know this copy's
     *  course id) — the menu says "course not recognised" and shows `problem.error`, never "offline" */
    readonly problem: JourneyProblem | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

function asProblem(status: number, body: unknown): JourneyProblem | null {
  if (status !== 409 || !isRecord(body)) return null;
  const { error, problem, courseId } = body;
  return problem === 'unknown-course' && typeof error === 'string' && typeof courseId === 'string' ? { error, problem, courseId } : null;
}

async function failure(res: Response, what: string): Promise<ApiError> {
  let message = `${what} failed (HTTP ${res.status})`;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    // not JSON (e.g. a proxy error page) — keep the generic message
  }
  if (isRecord(body) && typeof body.error === 'string') message = body.error;
  return new ApiError(res.status, message, asProblem(res.status, body));
}

const profilePath = (profile: string): string => encodeURIComponent(profile);

export async function getBoot(signal?: AbortSignal): Promise<BootPayload> {
  const res = await fetch('/api/boot', { signal, cache: 'no-store' });
  if (!res.ok) throw await failure(res, 'Loading the course');
  return (await res.json()) as BootPayload;
}

/** The SSD copy, or null when the server has none (204). */
export async function getProgress(profile: string): Promise<unknown> {
  const res = await fetch(`/api/progress/${profilePath(profile)}`, { cache: 'no-store' });
  if (res.status === 204) return null;
  if (!res.ok) throw await failure(res, 'Reading progress');
  return (await res.json()) as unknown;
}

/** keepalive bodies are capped at 64 KB by the browser — callers check the size (state/progress.ts). */
export async function putProgress(profile: string, body: string, opts: { keepalive?: boolean } = {}): Promise<void> {
  const res = await fetch(`/api/progress/${profilePath(profile)}`, {
    method: 'PUT',
    headers: WRITE_HEADERS,
    body,
    keepalive: opts.keepalive ?? false,
  });
  if (!res.ok) throw await failure(res, 'Saving progress');
}

/** Her plan status. null = 204 (not connected, JS Journey unreachable, or an unusable answer: keep the
 *  cached copy). Throws an ApiError with `problem` (409) when JS Journey does not know the course. */
export async function getJourneyStatus(profile: string): Promise<JourneyStatus | null> {
  const res = await fetch(`/api/journey/${profilePath(profile)}/status`, { cache: 'no-store' });
  if (res.status === 204) return null;
  if (!res.ok) throw await failure(res, 'Reading the JS Journey plan');
  return (await res.json()) as JourneyStatus;
}

/** Saves her student link once JS Journey accepts it. Errors: 400 malformed link, 502 JS Journey refused
 *  it or is unreachable (message says which), 409 + `problem` = the link is fine but JS Journey does not
 *  know this copy's course id (show `problem.error`: it names the id). Re-queues rejected updates. */
export async function connectJourney(profile: string, link: string): Promise<Profile> {
  const res = await fetch(`/api/profiles/${profilePath(profile)}/journey`, {
    method: 'PUT',
    headers: WRITE_HEADERS,
    body: JSON.stringify({ link }),
  });
  if (!res.ok) throw await failure(res, 'Connecting JS Journey');
  return (await res.json()) as Profile;
}

export async function disconnectJourney(profile: string): Promise<Profile> {
  const res = await fetch(`/api/profiles/${profilePath(profile)}/journey`, { method: 'DELETE', headers: WRITE_HEADERS });
  if (!res.ok) throw await failure(res, 'Disconnecting JS Journey');
  return (await res.json()) as Profile;
}

/** Rahul's feed. null = 204 (not connected, or JS Journey unreachable with no copy yet). `stale` = the
 *  server answered from its last good copy (header x-course-player-stale: 1). `cursor` pages updates. */
export async function getFeed(profile: string, cursor: string | null = null): Promise<{ feed: JourneyFeed; stale: boolean } | null> {
  const query = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
  const res = await fetch(`/api/journey/${profilePath(profile)}/feed${query}`, { cache: 'no-store' });
  if (res.status === 204) return null;
  if (!res.ok) throw await failure(res, 'Reading Rahul’s feed');
  return { feed: (await res.json()) as JourneyFeed, stale: res.headers.get('x-course-player-stale') === '1' };
}

/** "Got it" — the server queues it and retries, so a 202 is enough. */
export async function postFeedRead(profile: string, ids: string[]): Promise<void> {
  const res = await fetch(`/api/journey/${profilePath(profile)}/feed/read`, {
    method: 'POST',
    headers: WRITE_HEADERS,
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw await failure(res, 'Marking Rahul’s messages read');
}

/** Her progress for the coach view (latest wins on the server). keepalive on Quit / pagehide. */
export async function putProgressSnapshot(profile: string, snapshot: ProgressSnapshot, opts: { keepalive?: boolean } = {}): Promise<void> {
  const res = await fetch(`/api/journey/${profilePath(profile)}/progress`, {
    method: 'PUT',
    headers: WRITE_HEADERS,
    body: JSON.stringify(snapshot),
    keepalive: opts.keepalive ?? false,
  });
  if (!res.ok) throw await failure(res, 'Sending progress to JS Journey');
}

/** Hands her update to the local server's outbox: 202 = saved there (connected or not — v3), NOT
 *  delivered. Ask getOutbox(…, { waitMs }) for its delivery state. 400 = a body JS Journey would refuse. */
export async function postSession(profile: string, session: JourneySession): Promise<OutboxState> {
  const res = await fetch(`/api/journey/${profilePath(profile)}/sessions`, {
    method: 'POST',
    headers: WRITE_HEADERS,
    body: JSON.stringify(session),
    keepalive: true, // Quit and pagehide send the last session while the page goes away
  });
  if (!res.ok) throw await failure(res, 'Sending the session');
  return (await res.json()) as OutboxState;
}

/** Her updates' delivery state (OutboxState.updates: queued / rejected / delivered receipts). `waitMs`
 *  (≤ 10 000) = the server answers once the deliveries in flight have settled, or after that long —
 *  right after postSession, `{ waitMs: 8000 }` tells "Sent to Rahul ✓" / "Saved ✓" / rejected in one call. */
export async function getOutbox(profile: string, opts: { waitMs?: number } = {}): Promise<OutboxState> {
  const query = opts.waitMs === undefined ? '' : `?wait=${Math.round(opts.waitMs)}`;
  const res = await fetch(`/api/journey/${profilePath(profile)}/outbox${query}`, { cache: 'no-store' });
  if (!res.ok) throw await failure(res, 'Reading the outbox');
  return (await res.json()) as OutboxState;
}

/** "Try again": re-queues her rejected updates (all, or `ids`) and starts a delivery. 202 = re-queued,
 *  not delivered — follow with getOutbox(…, { waitMs }). */
export async function retryOutbox(profile: string, ids?: string[]): Promise<OutboxState> {
  const res = await fetch(`/api/journey/${profilePath(profile)}/outbox/retry`, {
    method: 'POST',
    headers: WRITE_HEADERS,
    body: JSON.stringify(ids === undefined ? {} : { ids }),
  });
  if (!res.ok) throw await failure(res, 'Sending the update again');
  return (await res.json()) as OutboxState;
}

export async function quitServer(): Promise<void> {
  const res = await fetch('/api/quit', { method: 'POST', headers: WRITE_HEADERS });
  if (!res.ok) throw await failure(res, 'Quitting');
}

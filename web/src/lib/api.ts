// The only module that talks to the course server. Every non-GET /api call carries
// `x-course-player: 1` — the server's CSRF rule (server/app.ts) answers 403 without it, and that
// includes the keepalive PUT on pagehide. Errors carry the server's `{error}` message.
import type { BootPayload, JourneyFeed, JourneySession, JourneyStatus, OutboxState, Profile, ProgressSnapshot } from '../../../shared/types';

const WRITE_HEADERS = { 'content-type': 'application/json', 'x-course-player': '1' } as const;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function failure(res: Response, what: string): Promise<ApiError> {
  let message = `${what} failed (HTTP ${res.status})`;
  try {
    const body: unknown = await res.json();
    if (typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string') {
      message = (body as { error: string }).error;
    }
  } catch {
    // not JSON (e.g. a proxy error page) — keep the generic message
  }
  return new ApiError(res.status, message);
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

export async function getJourneyStatus(profile: string): Promise<JourneyStatus | null> {
  const res = await fetch(`/api/journey/${profilePath(profile)}/status`, { cache: 'no-store' });
  if (res.status === 204) return null;
  if (!res.ok) throw await failure(res, 'Reading the JS Journey plan');
  return (await res.json()) as JourneyStatus;
}

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

export async function quitServer(): Promise<void> {
  const res = await fetch('/api/quit', { method: 'POST', headers: WRITE_HEADERS });
  if (!res.ok) throw await failure(res, 'Quitting');
}

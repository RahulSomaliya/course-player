// Her updates as the local outbox knows them (docs/spec-v3-study-timer.md A2, A5, A6). A 202 from POST
// sessions means "saved in the outbox", NEVER "sent" — the 2026-10-05 card flashed "Sent ✓" on that and
// Rahul got nothing. "Sent to Rahul ✓" needs a `delivered` entry (server/journey.ts keeps receipts);
// queued and rejected ones stay listed on top of "Your updates" until they go through. Pure helpers;
// state/journey.ts fetches the outbox.
import type { Course, JourneyFeed, JourneySession, OutboxState, OutboxUpdate, StudentUpdate } from '../../../shared/types';

export type Delivery = { state: 'delivered' } | { state: 'queued' } | { state: 'rejected'; error: string } | { state: 'unknown' };

/** What became of update `id`. 'unknown' = not listed (the server keeps the last 50 receipts only). */
export function deliveryOf(o: OutboxState, id: string): Delivery {
  const u = o.updates.find((x) => x.id === id);
  if (u === undefined) return { state: 'unknown' };
  if (u.state === 'rejected') return { state: 'rejected', error: u.error };
  return { state: u.state };
}

export type WaitingUpdate = Extract<OutboxUpdate, { state: 'queued' | 'rejected' }>;

/** Queued + rejected updates, newest first, minus any the feed already has (delivered meanwhile). */
export function waitingUpdates(updates: readonly OutboxUpdate[], feed: JourneyFeed | null): WaitingUpdate[] {
  const inFeed = new Set((feed?.updates ?? []).map((u) => u.id));
  return updates
    .filter((u): u is WaitingUpdate => (u.state === 'queued' || u.state === 'rejected') && !inFeed.has(u.id))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** A waiting update drawn like a delivered one (screens/updates/UpdateItem). */
export function asStudentUpdate(s: JourneySession, course: Course): StudentUpdate {
  return {
    id: s.id,
    source: 'player',
    studyDate: s.studyDate,
    createdAt: s.endedAt,
    minutes: s.minutes,
    sectionNumber: s.sectionNumber,
    sectionTitle: course.sections.find((x) => x.number === s.sectionNumber)?.title ?? null,
    lectures: s.lecturesCompleted.map(({ section, lecture, title }) => ({ section, lecture, title })),
    mood: s.mood,
    note: s.note,
    stuck: s.stuck,
    coachReadAt: null,
    replies: [],
  };
}

/** The outbox's "HTTP 404 — unknown course" as "unknown course (HTTP 404)": the words first. */
export function readableReason(error: string): string {
  const m = /^HTTP (\d{3}) — ([\s\S]+)$/.exec(error.trim());
  return m ? `${m[2]} (HTTP ${m[1]})` : error;
}

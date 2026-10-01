// The feed Rahul → Mansi (docs/spec-v2-coaching.md "Feed"): his replies to her updates and his
// standalone notes. Pure helpers; web/src/state/journey.ts fetches, caches and marks things read.
//
// Read queue: "Got it" hides the messages at once and POSTs feed/read. The local server queues that
// POST, but a feed fetched before JS Journey applied it still says `readAt: null` — without the local
// queue the "From Rahul" card would come back on the next refresh. readQueueAfter() keeps an id until
// the server confirms it (or the message is gone), and those ids are re-sent on every refresh.
import type { CoachMessage, JourneyFeed, StudentUpdate } from '../../../shared/types';
import { dayOfWeekLabel, daysBetween } from './dates';
import { formatShortDate } from './format';

/** refetch on window focus once the last fetch is this old */
export const FEED_REFRESH_MS = 5 * 60_000;
const SNIPPET_MAX = 60;

export interface FromRahulItem {
  message: CoachMessage;
  /** the update this reply answers; null for a standalone note */
  replyTo: StudentUpdate | null;
}

/** Every reply/note she has not seen, newest first — from the first page's updates AND `unreadReplies`
 *  (older updates carrying an unread reply: Rahul replies from his history too). Built from the page
 *  alone, such a reply was never shown nor acknowledged. Mirror: JS Journey lib/journey-view.ts. */
export function unreadFromRahul(feed: JourneyFeed | null, readIds: ReadonlySet<string>): FromRahulItem[] {
  if (feed === null) return [];
  const unread = (m: CoachMessage): boolean => m.readAt === null && !readIds.has(m.id);
  const items: FromRahulItem[] = feed.notes.filter(unread).map((message) => ({ message, replyTo: null }));
  const seen = new Set<string>();
  for (const u of [...feed.updates, ...(feed.unreadReplies ?? [])]) {
    for (const r of u.replies) {
      if (!unread(r) || seen.has(r.id)) continue;
      seen.add(r.id);
      items.push({ message: r, replyTo: u });
    }
  }
  return items.sort((a, b) => Date.parse(b.message.createdAt) - Date.parse(a.message.createdAt));
}

export type HistoryItem = { kind: 'update'; update: StudentUpdate } | { kind: 'note'; note: CoachMessage };

/** "Your updates" with Rahul's standalone notes interleaved by time, newest first. Mirror of JS Journey
 *  lib/journey-view.ts withNotes: her web page marks a note read as soon as it shows, after which "From
 *  Rahul" here skips it — with no note in the history, one visit there lost it from both apps.
 *  `complete` = these updates reach her oldest one (no older page): then notes older than all of them go
 *  at the end; otherwise only notes newer than the oldest update shown (notes come on page 1 only). */
export function withNotes(updates: readonly StudentUpdate[], notes: readonly CoachMessage[], complete: boolean): HistoryItem[] {
  const oldest = updates.length ? updates[updates.length - 1]!.createdAt : null;
  const shown = notes.filter((n) => complete || (oldest !== null && n.createdAt >= oldest));
  const items: HistoryItem[] = [
    ...updates.map((update): HistoryItem => ({ kind: 'update', update })),
    ...shown.map((note): HistoryItem => ({ kind: 'note', note })),
  ];
  const at = (i: HistoryItem): number => Date.parse(i.kind === 'update' ? i.update.createdAt : i.note.createdAt);
  return items.sort((a, b) => at(b) - at(a));
}

/** "On your Tue update" + her note as a short quote (null when the update had no note). */
export function replyContext(update: StudentUpdate, today: string): { lead: string; quote: string | null } {
  const ago = daysBetween(update.studyDate, today);
  const lead =
    ago <= 0
      ? 'On today’s update'
      : ago === 1
        ? 'On yesterday’s update'
        : ago < 7
          ? `On your ${dayOfWeekLabel(update.studyDate)} update`
          : `On your ${formatShortDate(update.studyDate)} update`;
  return { lead, quote: update.note === null || update.note.trim() === '' ? null : snippet(update.note) };
}

/** One line, ≤ 60 characters, cut at a word boundary. */
export function snippet(text: string, max = SNIPPET_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/, '')}…`;
}

/** The read queue after a fresh feed: ids still unread on the server (re-send them); the rest are done. */
export function readQueueAfter(queue: ReadonlySet<string>, feed: JourneyFeed): Set<string> {
  const stillUnread = new Set<string>();
  for (const m of feed.notes) if (m.readAt === null) stillUnread.add(m.id);
  // unreadReplies too: a queued "Got it" on a reply to an older update must survive until confirmed
  for (const u of [...feed.updates, ...(feed.unreadReplies ?? [])]) for (const r of u.replies) if (r.readAt === null) stillUnread.add(r.id);
  return new Set([...queue].filter((id) => stillUnread.has(id)));
}

/**
 * #/updates after "Show more": the store's first page (it refreshes on a sign-off or a refocus), the
 * first page as it was when "Show more" first ran (`frozen`), then the older pages fetched from its
 * cursor — newest first, each update once, the refreshed copy winning. WHY `frozen`: a new update pushes
 * the refreshed first page's last item to position 31, which the older pages (cursor after the OLD
 * page) never include — without the frozen copy it vanished from the list (2026-10-01 review).
 */
export function mergeUpdatePages(first: readonly StudentUpdate[], frozen: readonly StudentUpdate[], older: readonly StudentUpdate[]): StudentUpdate[] {
  const seen = new Set<string>();
  return [...first, ...frozen, ...older].filter((u) => {
    if (seen.has(u.id)) return false;
    seen.add(u.id);
    return true;
  });
}

export function shouldRefetch(lastFetchAt: number | null, now: number): boolean {
  return lastFetchAt === null || now - lastFetchAt >= FEED_REFRESH_MS;
}

// ---- validation (the cached copy in localStorage) -------------------------------------------------

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === 'string';
const isStrOrNull = (x: unknown): boolean => x === null || isStr(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

function isMessage(x: unknown): x is CoachMessage {
  return isRecord(x) && isStr(x.id) && isStr(x.body) && isStr(x.createdAt) && isStrOrNull(x.readAt);
}

function isUpdate(x: unknown): x is StudentUpdate {
  return (
    isRecord(x) &&
    isStr(x.id) &&
    (x.source === 'player' || x.source === 'manual') &&
    isStr(x.studyDate) &&
    isStr(x.createdAt) &&
    isNum(x.minutes) &&
    (x.sectionNumber === null || isNum(x.sectionNumber)) &&
    isStrOrNull(x.sectionTitle) &&
    Array.isArray(x.lectures) &&
    x.lectures.every((l) => isRecord(l) && isNum(l.section) && isNum(l.lecture) && isStr(l.title)) &&
    isStrOrNull(x.mood) &&
    isStrOrNull(x.note) &&
    typeof x.stuck === 'boolean' &&
    isStrOrNull(x.coachReadAt) &&
    Array.isArray(x.replies) &&
    x.replies.every(isMessage)
  );
}

export function isJourneyFeed(x: unknown): x is JourneyFeed {
  return (
    isRecord(x) &&
    Array.isArray(x.updates) &&
    x.updates.every(isUpdate) &&
    Array.isArray(x.notes) &&
    x.notes.every(isMessage) &&
    (x.unreadReplies === undefined || (Array.isArray(x.unreadReplies) && x.unreadReplies.every(isUpdate))) &&
    isNum(x.unreadForStudent) &&
    isStrOrNull(x.nextCursor)
  );
}

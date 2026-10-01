import { describe, expect, it } from 'vitest';
import type { CoachMessage, JourneyFeed, StudentUpdate } from '../../../shared/types';
import { FEED_REFRESH_MS, isJourneyFeed, mergeUpdatePages, readQueueAfter, replyContext, shouldRefetch, snippet, unreadFromRahul, withNotes } from './feed';

const msg = (id: string, createdAt: string, readAt: string | null = null, body = `body ${id}`): CoachMessage => ({ id, body, createdAt, readAt });

const update = (id: string, studyDate: string, over: Partial<StudentUpdate> = {}): StudentUpdate => ({
  id,
  source: 'player',
  studyDate,
  createdAt: `${studyDate}T18:00:00.000Z`,
  minutes: 72,
  sectionNumber: 7,
  sectionTitle: 'Thinking In React - State Management',
  lectures: [],
  mood: '🙂',
  note: null,
  stuck: false,
  coachReadAt: null,
  replies: [],
  ...over,
});

const feed = (over: Partial<JourneyFeed> = {}): JourneyFeed => ({ updates: [], notes: [], unreadForStudent: 0, nextCursor: null, ...over });

describe('unreadFromRahul ("From Rahul" at the top of home)', () => {
  const tue = update('u-tue', '2026-09-29', {
    note: 'useEffect cleanup confused me',
    replies: [msg('r1', '2026-09-29T20:00:00Z', '2026-09-29T21:00:00Z'), msg('r2', '2026-09-30T07:00:00Z')],
  });
  const wed = update('u-wed', '2026-09-30', { replies: [msg('r3', '2026-09-30T19:30:00Z')] });
  const f = feed({ updates: [wed, tue], notes: [msg('n1', '2026-10-01T06:00:00Z'), msg('n0', '2026-09-20T06:00:00Z', '2026-09-20T07:00:00Z')] });

  it('every unread reply + standalone note, newest first, each reply with the update it answers', () => {
    const items = unreadFromRahul(f, new Set());
    expect(items.map((i) => i.message.id)).toEqual(['n1', 'r3', 'r2']);
    expect(items[0]?.replyTo).toBeNull();
    expect(items[2]?.replyTo?.id).toBe('u-tue');
  });

  it('hides what she already marked read here while the server still reports it unread', () => {
    expect(unreadFromRahul(f, new Set(['r2', 'n1'])).map((i) => i.message.id)).toEqual(['r3']);
  });

  // JS Journey review 2026-10-01: a reply Rahul writes from his history on an update OUTSIDE the first
  // page was never shown nor acknowledged; the first page now carries those updates in `unreadReplies`
  it('also reads `unreadReplies` (older updates with an unread reply), each reply once', () => {
    const old = update('u-old', '2026-08-30', { replies: [msg('r-old', '2026-10-01T05:00:00Z')] });
    const items = unreadFromRahul({ ...f, unreadReplies: [old, wed] }, new Set());
    expect(items.map((i) => i.message.id)).toEqual(['n1', 'r-old', 'r3', 'r2']);
    expect(items[1]?.replyTo?.id).toBe('u-old');
    expect(unreadFromRahul({ ...f, unreadReplies: [old] }, new Set(['r-old'])).map((i) => i.message.id)).not.toContain('r-old');
  });

  it('nothing unread → empty (the block is absent)', () => {
    expect(unreadFromRahul(feed({ updates: [update('x', '2026-09-30')] }), new Set())).toEqual([]);
    expect(unreadFromRahul(null, new Set())).toEqual([]);
  });
});

describe('replyContext', () => {
  const today = '2026-10-01'; // Thu
  it('a weekday within the last week, with her note quoted', () => {
    expect(replyContext(update('a', '2026-09-29', { note: 'useEffect cleanup confused me' }), today)).toEqual({
      lead: 'On your Tue update',
      quote: 'useEffect cleanup confused me',
    });
  });
  it('today / yesterday read naturally', () => {
    expect(replyContext(update('a', '2026-10-01'), today).lead).toBe('On today’s update');
    expect(replyContext(update('a', '2026-09-30'), today).lead).toBe('On yesterday’s update');
  });
  it('older than a week: the date', () => {
    expect(replyContext(update('a', '2026-09-22'), today).lead).toBe('On your 22 Sep update');
  });
  it('no note → no quote', () => {
    expect(replyContext(update('a', '2026-09-29'), today).quote).toBeNull();
  });
});

describe('snippet', () => {
  it('keeps short text, trims and collapses whitespace', () => {
    expect(snippet('  useEffect\n cleanup  ')).toBe('useEffect cleanup');
  });
  it('cuts long text at a word boundary with an ellipsis', () => {
    const s = snippet('The dependency array finally makes sense but cleanup functions still feel like magic to me');
    expect(s).toBe('The dependency array finally makes sense but cleanup…');
    expect(s.length).toBeLessThanOrEqual(61);
  });
});

describe('readQueueAfter (Got it survives a slow or offline JS Journey)', () => {
  const f = feed({
    updates: [update('u', '2026-09-30', { replies: [msg('r1', '2026-09-30T19:00:00Z'), msg('r2', '2026-09-30T20:00:00Z', '2026-10-01T08:00:00Z')] })],
    notes: [msg('n1', '2026-10-01T06:00:00Z')],
  });
  it('keeps ids the server still reports unread (to send again), drops confirmed and vanished ones', () => {
    expect([...readQueueAfter(new Set(['r1', 'r2', 'n1', 'gone']), f)].sort()).toEqual(['n1', 'r1']);
  });
  it('a reply still unread on an OLDER update (unreadReplies) stays queued — dropping it would bring "From Rahul" back', () => {
    const withOld = { ...f, unreadReplies: [update('u-old', '2026-08-30', { replies: [msg('r-old', '2026-10-01T05:00:00Z')] })] };
    expect([...readQueueAfter(new Set(['r-old']), withOld)]).toEqual(['r-old']);
  });
});

// Review 2026-10-01: after "Show more", a refreshed first page (a sign-off, a refocus) pushed its last
// update to position 31 — off page 1, and before where the older pages started. It vanished.
describe('mergeUpdatePages (#/updates: the first page refreshes while older pages stay)', () => {
  const u = (n: number): StudentUpdate => update(`u${n}`, `2026-09-${String(n).padStart(2, '0')}`);
  it('keeps an update that slid off the refreshed first page, in order, once', () => {
    const firstAtShowMore = [u(30), u(29), u(28)]; // the page "Show more" continued from
    const refreshed = [u(31), u(30), u(29)]; // a new update arrived: u28 slid to page 2
    const older = [u(27), u(26)]; // fetched after u28's cursor
    expect(mergeUpdatePages(refreshed, firstAtShowMore, older).map((x) => x.id)).toEqual(['u31', 'u30', 'u29', 'u28', 'u27', 'u26']);
  });
  it('the refreshed copy of an update wins (a new reply under it)', () => {
    const replied = { ...u(30), replies: [msg('r', '2026-09-30T20:00:00Z')] };
    expect(mergeUpdatePages([replied], [u(30)], [])[0]?.replies).toHaveLength(1);
  });
});

describe('shouldRefetch (on focus after 5 min)', () => {
  it('only once 5 min have passed since the last fetch', () => {
    expect(FEED_REFRESH_MS).toBe(5 * 60_000);
    expect(shouldRefetch(null, 1000)).toBe(true);
    expect(shouldRefetch(0, FEED_REFRESH_MS - 1)).toBe(false);
    expect(shouldRefetch(0, FEED_REFRESH_MS)).toBe(true);
  });
});

describe('isJourneyFeed (the localStorage cache is never trusted)', () => {
  it('accepts a feed and rejects junk', () => {
    expect(isJourneyFeed(feed({ updates: [update('u', '2026-09-30', { replies: [msg('r', '2026-09-30T19:00:00Z')] })], notes: [msg('n', 'x')] }))).toBe(true);
    expect(isJourneyFeed({ updates: 'x' })).toBe(false);
    expect(isJourneyFeed(feed({ notes: [{ id: 1 } as unknown as CoachMessage] }))).toBe(false);
    expect(isJourneyFeed(null)).toBe(false);
  });
  it('unreadReplies is optional (a cache from before it, an older JS Journey) but checked when present', () => {
    expect(isJourneyFeed(feed({ unreadReplies: [update('u', '2026-09-30', { replies: [msg('r', 'x')] })] }))).toBe(true);
    expect(isJourneyFeed(feed({ unreadReplies: 'x' as never }))).toBe(false);
    expect(isJourneyFeed(feed({ unreadReplies: [{ id: 'u' } as never] }))).toBe(false);
  });
});

// Mirror of JS Journey lib/journey-view.ts withNotes. Her web page marks a note read the moment it shows;
// the player then skipped it in "From Rahul" and listed no notes anywhere, so one visit there lost it.
describe('withNotes (his notes stay findable in "Your updates")', () => {
  const ups = [update('u3', '2026-09-30'), update('u2', '2026-09-28'), update('u1', '2026-09-25')];
  const notes = [msg('n-new', '2026-10-01T06:00:00Z', 'x'), msg('n-mid', '2026-09-29T06:00:00Z', 'x'), msg('n-old', '2026-09-01T06:00:00Z', 'x')];
  const kinds = (items: ReturnType<typeof withNotes>) => items.map((i) => (i.kind === 'note' ? i.note.id : i.update.id));
  it('interleaves them by time within the updates shown; older ones wait for a complete list', () => {
    expect(kinds(withNotes(ups.slice(0, 2), notes, false))).toEqual(['n-new', 'u3', 'n-mid', 'u2']);
    expect(kinds(withNotes(ups, notes, true))).toEqual(['n-new', 'u3', 'n-mid', 'u2', 'u1', 'n-old']);
    expect(kinds(withNotes([], notes, true))).toEqual(['n-new', 'n-mid', 'n-old']);
  });
});

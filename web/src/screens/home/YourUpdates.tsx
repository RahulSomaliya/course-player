// "Your updates" — her latest 3 updates, each with Rahul's replies threaded under it, and his notes from
// the same days among them (lib/feed.ts withNotes); "See all" opens #/updates. v3 (spec A6): updates
// still in the local outbox (waiting / refused) sit on top — listed even before any feed exists, because
// one that silently never showed up is how the 2026-10-05 sign-off went unnoticed. Nothing at all → no
// block. Offline (the server's last good copy) → a quiet note says so.
import type { JourneyFeed, OutboxUpdate } from '../../../../shared/types';
import { todayKey } from '../../lib/dates';
import { withNotes } from '../../lib/feed';
import { waitingUpdates } from '../../lib/outbox';
import { hrefFor } from '../../lib/router';
import { NoteItem, UpdateItem, WaitingItem } from '../updates/UpdateItem';

const LATEST = 3;

export function YourUpdates({
  feed,
  readIds,
  stale,
  outbox,
}: {
  feed: JourneyFeed | null;
  readIds: ReadonlySet<string>;
  stale: boolean;
  outbox: readonly OutboxUpdate[];
}) {
  const waiting = waitingUpdates(outbox, feed);
  const more = feed !== null && (feed.updates.length > LATEST || feed.nextCursor !== null);
  const items = feed === null ? [] : withNotes(feed.updates.slice(0, LATEST), feed.notes, !more);
  if (items.length === 0 && waiting.length === 0) return null;
  const today = todayKey();
  return (
    <section aria-labelledby="updates-title">
      <div className="flex items-baseline justify-between gap-4 border-b border-line pb-4">
        <h2 id="updates-title" className="text-base font-semibold text-ink">
          Your updates
        </h2>
        {/* the course server answered from its last good copy (JS Journey unreachable) */}
        {stale && <p className="mr-auto text-sm text-ink-subtle">Offline — showing the last copy</p>}
        {more && (
          <a href={hrefFor({ name: 'updates' })} className="rounded-sm text-sm font-medium text-accent-ink underline-offset-4 hover:underline">
            See all
          </a>
        )}
      </div>
      {waiting.map((w) => (
        <WaitingItem key={w.id} waiting={w} today={today} />
      ))}
      {items.map((i) =>
        i.kind === 'update' ? (
          <UpdateItem key={i.update.id} update={i.update} today={today} readIds={readIds} unreadAbove />
        ) : (
          <NoteItem key={i.note.id} note={i.note} today={today} readIds={readIds} unreadAbove />
        ),
      )}
    </section>
  );
}

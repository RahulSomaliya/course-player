// "Your updates" — her latest 3 updates, each with Rahul's replies threaded under it, and his notes from
// the same days among them (lib/feed.ts withNotes); "See all" opens #/updates. Nothing yet → no block.
// Offline (the server's last good copy) → a quiet note says so.
import type { JourneyFeed } from '../../../../shared/types';
import { todayKey } from '../../lib/dates';
import { withNotes } from '../../lib/feed';
import { hrefFor } from '../../lib/router';
import { NoteItem, UpdateItem } from '../updates/UpdateItem';

const LATEST = 3;

export function YourUpdates({ feed, readIds, stale }: { feed: JourneyFeed | null; readIds: ReadonlySet<string>; stale: boolean }) {
  if (feed === null) return null;
  const more = feed.updates.length > LATEST || feed.nextCursor !== null;
  const items = withNotes(feed.updates.slice(0, LATEST), feed.notes, !more);
  if (items.length === 0) return null;
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

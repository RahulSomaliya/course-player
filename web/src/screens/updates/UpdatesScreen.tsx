// `#/updates`: all her updates with Rahul's replies (and his notes among them, lib/feed.ts withNotes), newest first — the home layout, paginated with the
// feed cursor ("Show more"). The first page is the store's feed (already loaded, and it refreshes while
// this screen is open); later pages are fetched here and live only while the screen is open. The first
// page as it was at the first "Show more" is kept too (lib/feed.ts mergeUpdatePages says why).
import { useState } from 'react';
import type { StudentUpdate } from '../../../../shared/types';
import { useApp } from '../../app/context';
import { Header } from '../../components/Header';
import { Button } from '../../components/ui';
import { getFeed } from '../../lib/api';
import { todayKey } from '../../lib/dates';
import { mergeUpdatePages, withNotes } from '../../lib/feed';
import { useJourney } from '../../state/journey';
import { NoteItem, UpdateItem } from './UpdateItem';

export function UpdatesScreen() {
  const { profile } = useApp();
  const { feed, readIds, stale } = useJourney();
  /** `frozen` = the first page when "Show more" first ran; `updates` = the older pages from its cursor */
  const [more, setMore] = useState<{ frozen: StudentUpdate[]; updates: StudentUpdate[]; cursor: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const today = todayKey();
  const updates = mergeUpdatePages(feed?.updates ?? [], more?.frozen ?? [], more?.updates ?? []);
  const cursor = more === null ? (feed?.nextCursor ?? null) : more.cursor;
  // his notes ride on the first page only: among the updates loaded so far, all of them once complete
  const items = withNotes(updates, feed?.notes ?? [], cursor === null);

  const loadMore = async (): Promise<void> => {
    if (cursor === null) return;
    setBusy(true);
    setError(null);
    try {
      const page = await getFeed(profile.id, cursor);
      if (page === null) throw new Error('JS Journey is not reachable');
      const frozen = feed?.updates ?? [];
      setMore((m) => ({ frozen: m?.frozen ?? frozen, updates: [...(m?.updates ?? []), ...page.feed.updates], cursor: page.feed.nextCursor }));
    } catch (err) {
      console.warn('[journey] could not load older updates', err);
      setError('Couldn’t load older updates. Check the internet connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Header back />
      <main className="mx-auto max-w-[1148px] px-4 pb-24 pt-8 md:px-6 md:pt-12">
        <h1 className="text-2xl font-semibold text-ink">Your updates</h1>
        <p className="mt-2 text-ink-muted">
          Every sign-off you sent, with Rahul’s replies.
          {stale && <span className="text-ink-subtle"> Offline — showing the last copy.</span>}
        </p>
        <div className="mt-8 border-t border-line">
          {items.length === 0 ? (
            <p className="py-10 text-ink-muted">No updates yet. When you sign off, your update for Rahul shows up here.</p>
          ) : (
            items.map((i) =>
              i.kind === 'update' ? (
                <UpdateItem key={i.update.id} update={i.update} today={today} readIds={readIds} />
              ) : (
                <NoteItem key={i.note.id} note={i.note} today={today} readIds={readIds} />
              ),
            )
          )}
        </div>
        {cursor !== null && (
          <div className="mt-6">
            <Button variant="secondary" disabled={busy} onClick={() => void loadMore()}>
              {busy ? 'Loading…' : 'Show more'}
            </Button>
            {error && (
              <p role="alert" className="mt-3 text-sm text-ink">
                {error}
              </p>
            )}
          </div>
        )}
      </main>
    </>
  );
}

// One of her updates with Rahul's replies threaded under it — the same layout on home ("Your updates",
// latest 3) and on #/updates (all of them). On home an UNREAD reply is one quiet line: "From Rahul" at
// the top already shows it in full, and repeating it here put ~10 identical lines on one screen
// (2026-10-01 review). After Got it it shows in full, as history. #/updates (no From Rahul there) always
// shows the full reply and the New tag.
// v3 (spec A6): an update still in the local outbox is drawn the same way (WaitingItem) with one status
// line — "Waiting to send", or "Didn't reach Rahul — <reason> · Try again". Not red: calm ink + an icon.
import { CircleAlert, Clock3 } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { CoachMessage, StudentUpdate } from '../../../../shared/types';
import { useApp } from '../../app/context';
import { formatDay, formatDuration, formatMessageTime, plural } from '../../lib/format';
import { asStudentUpdate, readableReason, type WaitingUpdate } from '../../lib/outbox';
import { useJourneyStore } from '../../state/journey';

const MOOD_LABELS: Record<string, string> = { '😄': 'Great', '🙂': 'Good', '😐': 'Okay', '😩': 'Tough' };

interface Props {
  update: StudentUpdate;
  today: string;
  readIds: ReadonlySet<string>;
  /** home: an unread reply is shown above in "From Rahul" — here it is one line pointing there */
  unreadAbove?: boolean;
  /** v3: the delivery line of an update still in the outbox (WaitingItem) */
  status?: ReactNode;
}

export function UpdateItem({ update, today, readIds, unreadAbove = false, status }: Props) {
  const facts = [
    update.minutes > 0 ? formatDuration(update.minutes * 60) : 'Note',
    update.sectionNumber !== null ? `§${String(update.sectionNumber).padStart(2, '0')}${update.sectionTitle ? ` ${update.sectionTitle}` : ''}` : null,
    update.lectures.length > 0 ? plural(update.lectures.length, 'lecture') : null,
  ].filter(Boolean);
  return (
    <article className="border-b border-line py-5 last:border-b-0">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold text-ink">{formatDay(update.studyDate)}</h3>
        <p className="min-w-0 text-sm text-ink-muted">{facts.join(' · ')}</p>
        {update.mood && (
          <span className="text-base leading-none" role="img" aria-label={`Mood: ${MOOD_LABELS[update.mood] ?? update.mood}`}>
            {update.mood}
          </span>
        )}
        {update.stuck && <span className="inline-flex h-6 items-center rounded-full bg-accent-soft px-2.5 text-xs font-medium text-accent-ink">Stuck</span>}
      </header>
      {status}
      {update.note && <p className="mt-2 max-w-[68ch] whitespace-pre-line text-base text-ink">{update.note}</p>}
      {update.replies.length > 0 && (
        <ul className="mt-3 space-y-3 border-l border-line pl-4 sm:ml-1">
          {update.replies.map((r) => {
            const unread = r.readAt === null && !readIds.has(r.id);
            if (unread && unreadAbove) {
              return (
                <li key={r.id}>
                  <p className="text-sm text-ink-muted">Rahul replied · above</p>
                </li>
              );
            }
            return (
              <li key={r.id}>
                <p className="flex items-center gap-2 text-xs font-medium text-ink-muted">
                  Rahul · <time dateTime={r.createdAt}>{formatMessageTime(r.createdAt, today)}</time>
                  {unread && <NewMark />}
                </p>
                <p className="mt-0.5 max-w-[68ch] whitespace-pre-line text-sm text-ink">{r.body}</p>
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
}

function NewMark() {
  return (
    <span className="inline-flex items-center gap-1 text-accent-ink">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />
      New
    </span>
  );
}

/** One of Rahul's standalone notes among her updates (lib/feed.ts withNotes), styled like a reply. Read
 *  notes must show here: once her web page has shown a note it is read, "From Rahul" skips it, and this
 *  is the only place left to find it. On home an unread one is one line — "From Rahul" shows it in full. */
export function NoteItem({ note, today, readIds, unreadAbove = false }: { note: CoachMessage; today: string; readIds: ReadonlySet<string>; unreadAbove?: boolean }) {
  const unread = note.readAt === null && !readIds.has(note.id);
  return (
    <article className="border-b border-line py-5 last:border-b-0">
      <div className="border-l border-line pl-4 sm:ml-1">
        {unread && unreadAbove ? (
          <p className="text-sm text-ink-muted">Rahul sent a note · above</p>
        ) : (
          <>
            <p className="flex items-center gap-2 text-xs font-medium text-ink-muted">
              Rahul · note · <time dateTime={note.createdAt}>{formatMessageTime(note.createdAt, today)}</time>
              {unread && <NewMark />}
            </p>
            <p className="mt-0.5 max-w-[68ch] whitespace-pre-line text-sm text-ink">{note.body}</p>
          </>
        )}
      </div>
    </article>
  );
}

/** One of her updates still in the outbox (lib/outbox.ts waitingUpdates). "Try again" re-queues it
 *  (state/journey.ts retry); once delivered it leaves the outbox list and arrives with the feed. */
export function WaitingItem({ waiting, today }: { waiting: WaitingUpdate; today: string }) {
  const { course, profile } = useApp();
  const journey = useJourneyStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const retry = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await journey.retry(waiting.id);
    } catch (err) {
      console.warn(`[journey] could not re-send update ${waiting.id}`, err);
      if (alive.current) setError('Couldn’t reach the course app — is it still running?');
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const status =
    waiting.state === 'queued' ? (
      <p data-outbox="queued" className="mt-2 flex items-center gap-1.5 text-sm text-ink-muted">
        <Clock3 className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
        {profile.journeyConnected ? 'Waiting to send' : 'Waiting to send · connect JS Journey in the settings menu'}
      </p>
    ) : (
      <div data-outbox="rejected" className="mt-2 text-sm text-ink">
        <p className="flex items-start gap-1.5">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-ink-muted" strokeWidth={1.75} aria-hidden="true" />
          <span className="min-w-0">
            Didn’t reach Rahul — {readableReason(waiting.error)} ·{' '}
            <button
              type="button"
              onClick={() => void retry()}
              aria-disabled={busy || undefined}
              className={`rounded-sm font-medium text-accent-ink underline-offset-4 hover:underline ${busy ? 'pointer-events-none' : ''}`}
            >
              {busy ? 'Sending…' : 'Try again'}
            </button>
          </span>
        </p>
        {error && (
          <p role="alert" className="mt-1 pl-5 text-ink">
            {error}
          </p>
        )}
      </div>
    );
  return <UpdateItem update={asStudentUpdate(waiting.session, course)} today={today} readIds={EMPTY} status={status} />;
}

const EMPTY: ReadonlySet<string> = new Set();

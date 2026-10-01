// "From Rahul" — the top of home: every unread reply/note, newest first, a reply with the snippet of
// her update it answers. One "Got it" marks them all read. Nothing unread → no block at all.
// Motion: a soft rise on arrival; Got it → "✓ Got it" → the block fades out while it folds. A tall card
// clipped by a 220 ms fold showed half-cut lines of his text sliding away (2026-10-01 review), so: the
// fade is FAST AT FIRST (150 ms ease-out) and the fold SLOW AT FIRST (--ease-in): the card is mostly gone
// before the fold takes much height. (An ease-in fade over an ease-out fold — the obvious pairing —
// still showed clipped text at 70 % opacity, measured.) Layout shifts within 500 ms of an input do not
// count as CLS, and the fold starts 25–40 ms AFTER the hold (two renders): ACK_MS + 220 ms + ~40 ms must
// stay under 500. Do not lengthen the fold for tall cards — 260 ms ended at 498 ms, 240 ms at 490 ms.
import { Check } from 'lucide-react';
import { useState } from 'react';
import { Collapse } from '../../components/Collapse';
import { Button } from '../../components/ui';
import { todayKey } from '../../lib/dates';
import { replyContext, type FromRahulItem } from '../../lib/feed';
import { formatMessageTime } from '../../lib/format';

/** how long "✓ Got it" holds before the block folds away */
const ACK_MS = 220;

export function FromRahul({ items, onGotIt }: { items: FromRahulItem[]; onGotIt: (ids: string[]) => void }) {
  // While it acknowledges and collapses, keep showing what she just read (the store already hid it).
  const [acked, setAcked] = useState<FromRahulItem[] | null>(null);
  const [open, setOpen] = useState(true);
  const shown = acked ?? items;
  if (shown.length === 0) return null;
  const today = todayKey();

  const gotIt = (): void => {
    if (acked !== null) return;
    setAcked(items);
    onGotIt(items.map((i) => i.message.id));
    // the ✓ hold is feedback, kept under reduced motion too; the fold itself is instant there (Collapse)
    window.setTimeout(() => setOpen(false), ACK_MS);
  };

  return (
    <Collapse
      open={open}
      easeInOnClose
      onExited={() => {
        setAcked(null);
        setOpen(true);
      }}
    >
      {() => (
        <section
          aria-labelledby="from-rahul"
          data-block="from-rahul"
          className={`animate-arrive pb-12 transition-opacity duration-150 ease-out md:pb-16 ${open ? '' : 'opacity-0'}`}
        >
          <div className="rounded-lg border border-line bg-surface p-5 shadow-e1 sm:p-6">
            <div className="flex items-baseline justify-between gap-4">
              <h2 id="from-rahul" className="text-xs font-semibold uppercase tracking-[0.08em] text-accent-ink">
                From Rahul
              </h2>
              {shown.length > 1 && <p className="text-sm tabular-nums text-ink-muted">{shown.length} new</p>}
            </div>
            <ul className="mt-4 space-y-6">
              {shown.map(({ message, replyTo }) => {
                const ctx = replyTo ? replyContext(replyTo, today) : null;
                return (
                  <li key={message.id}>
                    {ctx && (
                      <p className="mb-2 max-w-[68ch] text-sm text-ink-muted">
                        {ctx.lead}
                        {ctx.quote && (
                          <>
                            : <q className="text-ink-muted italic">{ctx.quote}</q>
                          </>
                        )}
                      </p>
                    )}
                    <p className="max-w-[68ch] whitespace-pre-line text-lg leading-7 text-ink">{message.body}</p>
                    <p className="mt-1 text-sm text-ink-subtle">
                      <time dateTime={message.createdAt}>{formatMessageTime(message.createdAt, today)}</time>
                    </p>
                  </li>
                );
              })}
            </ul>
            <Button variant="secondary" className="mt-6 min-w-28" onClick={gotIt} aria-live="polite">
              {acked ? (
                <>
                  <Check className="size-4 animate-check-in text-accent" strokeWidth={2.25} aria-hidden="true" />
                  Got it
                </>
              ) : (
                'Got it'
              )}
            </Button>
          </div>
        </section>
      )}
    </Collapse>
  );
}

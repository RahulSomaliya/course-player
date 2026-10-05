// The sign-off card = one update for Rahul (docs/spec-v3-study-timer.md A5). Two kinds:
// - 'session' (the header chip / Quit): the summary as v2 had it — "1h 23m studied · started 9:14 am", the
//   lectures done, the section — then note, mood, "I'm stuck". The time is READ-ONLY until she asks:
//   "Edit time" opens hours + minutes (prefilled from the timer, never above it, ≤ 24 h), "Use timer" closes
//   them (Rahul, 2026-10-05: "editable if she wants to, not always" — always-open fields had pushed the
//   lectures summary down and read as a form to fill in). A timer over 24 h opens them by itself;
// - 'note' (menu "Note to Rahul…"): a note-only update — no time, note required; a running timer goes on.
// ONE primary button, "Send to Rahul" ("Send & quit" from Quit), disabled only when there is nothing to
// send — with the reason shown ONCE: a time problem sits next to the fields, never again under the button
// (it printed twice, 2026-10-05). No quiet "Quit, keep timer" / "Quit anyway" (Rahul, 2026-10-05: keep it
// simple): Quit = "Send & quit", or × to keep studying; once nothing runs, Quit quits straight away.
//
// After Send the card becomes a CONFIRMATION that stays until "Done", read from the outbox's delivery
// state (state/journey.ts awaitDelivery — one GET outbox?wait=), never from the 202: "Sent to Rahul ✓"
// (delivered) · "Saved ✓ — it will reach Rahul…" (still queued after ~8 s) · rejected → back on the form
// with the reason and "Try again" (same update, her note kept). The 2026-10-05 card flashed "Sent ✓" for
// 650 ms on a 202 while JS Journey refused the update and the outbox dropped it — so: no sub-second flash,
// and no success word before a delivered receipt. The timer stops the moment the outbox has the update
// (StudyController.signOff), before delivery settles.
//
// A timer over 24 h (a forgotten one) prefills nothing: Send waits until she types her real time
// (lib/signoff.ts prefillTime — a prefilled "24h 0m" once credited a day she never studied).
//
// The card belongs to the session it opened on (`openedOn`). If that one ends in another window of the
// app (sent / discarded there — state/study.ts header), the card says so and turns into a note form that
// keeps her words: it never follows a session started there since, and never sends this one again
// (review 2026-10-05: the stale tab re-sent it, JS Journey ignored the duplicate, the card said "Sent ✓").
//
// × / Escape / the scrim = "not now": the session keeps running (and a Quit is cancelled). Not while the
// POST is in flight: closing then let a send finish behind an unmounted card whose leftover timer
// reported a second outcome — App then quit after "keep studying" (2026-10-01 review). So close() waits
// for the hand-over, onDone fires at most once, and nothing is scheduled after unmount. Once the outbox
// has it, closing during the delivery wait is fine — the update is safe.
import { Check, LifeBuoy, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { JourneySession } from '../../../shared/types';
import { Dialog } from '../components/Dialog';
import { Button, IconButton } from '../components/ui';
import { useApp } from '../app/context';
import { formatDuration, formatElapsed, plural } from '../lib/format';
import { prefersReducedMotion } from '../lib/motion';
import { readableReason, type Delivery } from '../lib/outbox';
import { MOODS, canSend, cleanNote, timerMinutes, type Mood, type StudySession } from '../lib/session';
import { describeSession, parseTime, prefillTime, sentDetail, timeProblem } from '../lib/signoff';
import { useJourneyStore } from '../state/journey';
import { SESSION_ENDED_ELSEWHERE, useNow, useStudy, useStudyState, type HandOver } from '../state/study';

const MOOD_LABELS: Record<Mood, string> = { '😄': 'Great', '🙂': 'Good', '😐': 'Okay', '😩': 'Tough' };
/** = --animate-leave (index.css) */
const LEAVE_MS = 180;

/** Focus on close when what opened the card is gone (components/Dialog.tsx): the header's timer slot —
 *  the chip, or "Start studying" once Send / Discard stopped it — or, for a note, the menu it came from. */
const focusAfter = (mode: Props['mode']) => (): HTMLElement | null =>
  document.querySelector<HTMLElement>(mode === 'note' ? '[data-control="settings-menu"]' : '[data-control="sign-off"], [data-control="start-studying"]');

export interface SignOffOutcome {
  /** updates handed to the outbox (0 or 1) — App refreshes the feed and pushes the snapshot then */
  sent: number;
  /** stop the server now: "Quit" on the confirmation's button (the card opened from Quit) */
  quit: boolean;
}

interface Props {
  mode: 'session' | 'note';
  quitting: boolean;
  onDone: (outcome: SignOffOutcome) => void;
}

/** form → sending (hand-over + delivery wait) → done (the confirmation) | form again (refused) → leaving */
type Phase = 'form' | 'sending' | 'done' | 'leaving';

export function SignOffCard({ mode, quitting, onDone }: Props) {
  const { course, profile } = useApp();
  const study = useStudy();
  const journey = useJourneyStore();
  const { session } = useStudyState();
  /** the session this card is for — never one started in another window while it is open */
  const [openedOn] = useState(() => (mode === 'session' ? (session?.id ?? null) : null));
  const [phase, setPhase] = useState<Phase>('form');
  const [note, setNote] = useState('');
  const [mood, setMood] = useState<Mood | null>(null);
  const [stuck, setStuck] = useState(false);
  /** Time studied as typed; null = not touched, the fields follow the timer */
  const [typed, setTyped] = useState<{ hours: string; minutes: string } | null>(null);
  /** she chose "Edit time" (a timer over 24 h opens the fields without it) */
  const [editing, setEditing] = useState(false);
  /** the session and the moment of Send: the card keeps showing it after the timer stopped */
  const [frozen, setFrozen] = useState<{ session: StudySession; at: number } | null>(null);
  /** in the outbox: a later Send is "Try again" with the same update */
  const [handed, setHanded] = useState<JourneySession | null>(null);
  const [result, setResult] = useState<Extract<Delivery['state'], 'delivered' | 'queued'> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const timers = useRef<number[]>([]);
  const alive = useRef(true);
  const finished = useRef(false);
  const doneButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const noteId = useId();
  const moodLabel = useId();
  const timeHint = useId();
  const reasonId = useId();

  useEffect(() => {
    alive.current = true;
    return () => {
      // A timer scheduled AFTER this cleanup would never be cleared: later() checks `alive` instead.
      alive.current = false;
      timers.current.forEach((t) => window.clearTimeout(t));
      timers.current = [];
    };
  }, []);
  useEffect(() => {
    if (phase === 'done') doneButton.current?.focus();
  }, [phase]);

  const view = frozen?.session ?? (session !== null && session.id === openedOn ? session : null);
  const isSession = view !== null;
  /** its session ended in another window before she sent it here: a note form now, saying why */
  const endedElsewhere = openedOn !== null && view === null && handed === null;
  const now = useNow(isSession && frozen === null);
  const at = frozen?.at ?? now;
  const summary = view === null ? null : describeSession(view, course, at);
  const max = view === null ? 0 : timerMinutes(view, at);
  const prefill = view === null ? { hours: '0', minutes: '0' } : prefillTime(view, at);
  const hours = typed?.hours ?? prefill.hours;
  const minutes = typed?.minutes ?? prefill.minutes;
  const total = parseTime(hours, minutes);
  const problem = isSession && handed === null ? timeProblem(total, max, summary?.overDay === true && typed === null) : null;
  const sendable = isSession ? problem === null && canSend(handed?.minutes ?? total ?? 0, note) : cleanNote(note) !== null;
  const shownError = error ?? (endedElsewhere ? SESSION_ENDED_ELSEWHERE : null);
  // A time problem is printed next to the fields only — repeating it under the button read as two problems.
  const reason = problem !== null || sendable ? null : isSession ? 'Add the time you studied, or a note.' : 'Write a note for Rahul.';
  const busy = phase === 'sending' || phase === 'leaving';
  const lectureCount = summary === null ? 0 : summary.lectures.shown.length + summary.lectures.more;

  const later = (fn: () => void, ms: number): void => {
    if (!alive.current) return;
    timers.current.push(window.setTimeout(fn, ms));
  };

  const finish = (outcome: SignOffOutcome): void => {
    if (finished.current) return;
    finished.current = true;
    onDone(outcome);
  };

  const close = (quit: boolean): void => {
    if (phase === 'leaving') return;
    if (phase === 'sending' && handed === null) return; // the hand-over is in flight (see the header)
    setPhase('leaving');
    // the exit is motion (instant under reduced motion); `finish` is the real once-only guard
    later(() => finish({ sent: handed === null ? 0 : 1, quit }), prefersReducedMotion() ? 0 : LEAVE_MS);
  };

  const send = async (): Promise<void> => {
    if (busy || !sendable) return;
    setPhase('sending');
    setError(null);
    const answer = { minutes: total ?? 0, mood, note, stuck };
    let handOver: HandOver;
    if (handed !== null) {
      handOver = await study.resend({ ...handed, mood, note: cleanNote(note), stuck });
    } else if (view !== null) {
      setFrozen({ session: view, at: Date.now() });
      handOver = await study.signOff(view.id, answer);
    } else {
      handOver = await study.sendNote(answer);
    }
    if (!alive.current) return;
    if (!handOver.ok) {
      if (handed === null) setFrozen(null); // still running: the card follows the timer again
      setError(handOver.error);
      setPhase('form');
      return;
    }
    setHanded(handOver.update);
    let delivery: Delivery;
    try {
      delivery = await journey.awaitDelivery(handOver.update.id);
    } catch (err) {
      // The 202 came back, so the update IS in the outbox file: "Saved" is the honest word.
      console.warn(`[signoff] could not read the outbox after handing over ${handOver.update.id} — it is saved there`, err);
      delivery = { state: 'queued' };
    }
    if (!alive.current) return;
    if (delivery.state === 'rejected') {
      setError(`Didn’t reach Rahul — ${readableReason(delivery.error)}`);
      setPhase('form');
      return;
    }
    if (delivery.state === 'unknown') console.warn(`[signoff] ${handOver.update.id} is not in the outbox list — treating it as saved`);
    setResult(delivery.state === 'delivered' ? 'delivered' : 'queued');
    setPhase('done');
  };

  if (phase === 'done' || (phase === 'leaving' && result !== null)) {
    const delivered = result === 'delivered';
    return (
      <Dialog
        open
        onClose={() => close(false)}
        labelledBy={titleId}
        enter="rise"
        leaving={phase === 'leaving'}
        returnFocus={focusAfter(mode)}
        className="max-h-[calc(100dvh-2rem)] max-w-lg overflow-y-auto"
      >
        <div data-signoff-result={delivered ? 'delivered' : 'saved'} role="status" className="animate-arrive p-6">
          <div className="flex items-start gap-4">
            <span
              aria-hidden="true"
              className={`flex size-10 shrink-0 items-center justify-center rounded-full ${delivered ? 'bg-accent text-on-accent' : 'bg-accent-soft text-accent-ink'}`}
            >
              <Check className="size-5 animate-check-in" strokeWidth={2.25} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-xl font-semibold text-ink">
                {delivered ? 'Sent to Rahul' : 'Saved'}
              </h2>
              <p className="mt-1 text-ink-muted">
                {delivered
                  ? handed && sentDetail(handed)
                  : profile.journeyConnected
                    ? 'It will reach Rahul as soon as you’re online.'
                    : 'It will reach Rahul once JS Journey is connected (settings menu, top right).'}
              </p>
            </div>
          </div>
          <div className="mt-6 flex justify-end">
            <Button ref={doneButton} variant="secondary" data-control="signoff-done" className="min-w-28" onClick={() => close(quitting)}>
              {quitting ? 'Quit' : 'Done'}
            </Button>
          </div>
        </div>
      </Dialog>
    );
  }

  const primaryLabel = phase === 'sending' ? 'Sending…' : handed !== null ? 'Try again' : quitting ? 'Send & quit' : 'Send to Rahul';
  const timerLocked = busy || handed !== null;
  const fieldsOpen = summary !== null && (editing || summary.overDay);
  const studied = total !== null ? formatElapsed(total * 60) : '—';
  const edited = summary !== null && (summary.overDay || (total !== null && total !== max));

  return (
    <Dialog
      open
      onClose={() => close(false)}
      labelledBy={titleId}
      enter="rise"
      leaving={phase === 'leaving'}
      returnFocus={focusAfter(mode)}
      className="max-h-[calc(100dvh-2rem)] max-w-lg overflow-y-auto"
    >
      <div data-signoff={isSession ? 'session' : 'note'} className="p-6">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-xl font-semibold text-ink">
              {isSession ? `Nice work, ${profile.name}` : 'A note for Rahul'}
            </h2>
            {summary === null && <p className="mt-1 text-sm text-ink-muted">Something you studied away from the player — no time is logged.</p>}
          </div>
          <IconButton
            label={quitting ? 'Not now — keep studying' : 'Not now'}
            size="sm"
            className="-mr-2 -mt-1"
            disabled={phase === 'sending' && handed === null}
            onClick={() => close(false)}
          >
            <X className="size-4" strokeWidth={1.5} />
          </IconButton>
        </div>

        {/* the auto summary (v2): what the timer logged + what she did; the time is editable on demand */}
        {summary !== null && (
          <div className="mt-4 rounded-md bg-sunken px-4 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <p className="min-w-0 text-sm text-ink-muted">
                <span data-signoff="studied" className="text-base font-semibold tabular-nums text-ink">
                  {studied}
                </span>{' '}
                studied · <span data-signoff="started">started {summary.started}</span>
                {edited && <> · timer {summary.timer}</>}
              </p>
              {!timerLocked && !summary.overDay && (
                <button
                  type="button"
                  data-control={fieldsOpen ? 'signoff-use-timer' : 'signoff-edit-time'}
                  onClick={() => {
                    setTyped(null);
                    setEditing(!fieldsOpen);
                  }}
                  className="shrink-0 rounded-sm px-1 text-sm text-ink-muted underline-offset-4 hover:text-ink hover:underline"
                >
                  {fieldsOpen ? 'Use timer' : 'Edit time'}
                </button>
              )}
            </div>
            {fieldsOpen && (
              <fieldset className="mt-3" aria-describedby={timeHint}>
                <legend className="sr-only">Time studied</legend>
                <div className="flex items-center gap-2">
                  <TimeField label="Hours" unit="h" value={hours} disabled={timerLocked} onChange={(v) => setTyped({ hours: v, minutes })} invalid={problem !== null} />
                  <TimeField label="Minutes" unit="m" value={minutes} disabled={timerLocked} onChange={(v) => setTyped({ hours, minutes: v })} invalid={problem !== null} />
                </div>
                <p id={timeHint} data-signoff="time-hint" className={`mt-2 text-sm ${problem ? 'text-ink' : 'text-ink-subtle'}`} aria-live="polite">
                  {problem ??
                    (summary.overDay
                      ? 'The timer ran longer than a day — set the real time.'
                      : max === 0
                        ? 'Under a minute so far.'
                        : `Up to ${formatDuration(max * 60)} — less if you took breaks.`)}
                </p>
              </fieldset>
            )}
            {(summary.section !== null || lectureCount > 0) && (
              <>
                <p className="mt-2 text-sm text-ink-muted">{[lectureCount > 0 ? plural(lectureCount, 'lecture') + ' done' : null, summary.section].filter(Boolean).join(' · ')}</p>
                {summary.lectures.shown.length > 0 && (
                  <ul className="mt-2 space-y-1 text-sm text-ink">
                    {summary.lectures.shown.map((t, i) => (
                      <li key={`${i}-${t}`} className="flex items-start gap-2">
                        <Check className="mt-0.5 size-3.5 shrink-0 text-accent" strokeWidth={2} aria-hidden="true" />
                        <span className="min-w-0">{t}</span>
                      </li>
                    ))}
                    {summary.lectures.more > 0 && <li className="pl-5.5 text-ink-muted">+{summary.lectures.more} more</li>}
                  </ul>
                )}
              </>
            )}
          </div>
        )}

        <label htmlFor={noteId} className="mt-6 block text-sm font-medium text-ink">
          Note for Rahul{isSession && <span className="font-normal text-ink-muted"> (optional)</span>}
        </label>
        <textarea
          id={noteId}
          data-autofocus
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={2000}
          rows={4}
          disabled={busy}
          placeholder="What did you learn? Anything unclear?"
          className="mt-2 w-full resize-none rounded-md border border-line bg-surface px-3 py-2 text-base text-ink placeholder:text-ink-subtle sm:text-sm"
        />

        <p id={moodLabel} className="mt-5 text-sm font-medium text-ink">
          How did it feel?
        </p>
        <div role="radiogroup" aria-labelledby={moodLabel} className="mt-2 grid grid-cols-4 gap-2">
          {MOODS.map((m) => {
            const on = mood === m;
            return (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={MOOD_LABELS[m]}
                disabled={busy}
                onClick={() => setMood(on ? null : m)}
                className={`flex h-14 flex-col items-center justify-center gap-0.5 rounded-md border text-xl transition-transform duration-150 ease-out active:scale-95 ${
                  on ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-fill'
                }`}
              >
                <span aria-hidden="true">{m}</span>
                <span className={`text-[11px] font-medium ${on ? 'text-accent-ink' : 'text-ink-muted'}`}>{MOOD_LABELS[m]}</span>
              </button>
            );
          })}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1">
          <button
            type="button"
            aria-pressed={stuck}
            disabled={busy}
            onClick={() => setStuck((v) => !v)}
            className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm font-medium ${
              stuck ? 'border-transparent bg-accent-soft text-accent-ink' : 'border-line bg-surface text-ink hover:bg-fill'
            }`}
          >
            <LifeBuoy className="size-4" strokeWidth={1.5} aria-hidden="true" />
            I’m stuck
          </button>
          <span className="text-sm text-ink-muted">flags this update for Rahul</span>
        </div>

        {shownError && (
          <p role="alert" data-signoff="error" className="mt-5 text-sm text-ink">
            {shownError}
          </p>
        )}

        <div className="mt-6 flex flex-wrap items-center justify-end gap-x-2 gap-y-3">
          {view !== null && handed === null && (
            <div className="mr-auto flex min-h-10 items-center gap-1 text-sm">
              {discarding ? (
                <>
                  <span className="text-ink">Discard {summary?.timer}?</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    data-control="signoff-discard-confirm"
                    className="text-ink"
                    onClick={() => {
                      study.discard(view.id);
                      close(false);
                    }}
                  >
                    Yes, discard
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setDiscarding(false)}>
                    Keep
                  </Button>
                </>
              ) : (
                <button
                  type="button"
                  data-control="signoff-discard"
                  disabled={busy}
                  onClick={() => setDiscarding(true)}
                  className="rounded-sm px-1 text-ink-muted underline-offset-4 hover:text-ink hover:underline"
                >
                  Discard
                </button>
              )}
            </div>
          )}
          {/* Busy = aria-disabled + no pointer events, NOT `disabled`: the disabled look (50 % opacity)
              read as "undone" (2026-10-01). `disabled` is only for "nothing to send", with the reason. */}
          <Button
            variant="primary"
            data-control="signoff-primary"
            className={`min-w-36 ${busy ? 'pointer-events-none' : ''}`}
            disabled={!busy && !sendable}
            aria-disabled={busy || undefined}
            aria-describedby={problem !== null && fieldsOpen ? timeHint : reason ? reasonId : undefined}
            onClick={() => void send()}
          >
            {primaryLabel}
          </Button>
        </div>
        {reason && !busy && (
          <p id={reasonId} data-signoff="reason" className="mt-2 text-right text-sm text-ink-muted">
            {reason}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** One of the two Time studied fields: digits only (text + numeric keypad — type=number accepts "1e3"). */
function TimeField({ label, unit, value, disabled, invalid, onChange }: { label: string; unit: string; value: string; disabled: boolean; invalid: boolean; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-1.5">
      <input
        type="text"
        inputMode="numeric"
        aria-label={label}
        aria-invalid={invalid || undefined}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, '').slice(0, 4))}
        className="h-10 w-16 rounded-md border border-line bg-surface px-3 text-center text-base tabular-nums text-ink disabled:opacity-60 aria-[invalid=true]:border-ink-muted sm:text-sm"
      />
      <span aria-hidden="true" className="text-sm text-ink-muted">
        {unit}
      </span>
    </label>
  );
}

// The sign-off card = one update for Rahul (docs/spec-v2-coaching.md "Sign-off card"). It walks the
// queue StudyController.queue() gave it when it opened: earlier sessions first ("You studied 1h 12m on
// Tue — add a note for Rahul?"), then this one; with nothing unsigned, a note-only update.
// Top: the auto summary (nothing to fill in). Then the note (the main field), 4 moods, "I'm stuck".
// Send → the button morphs to "Sent ✓" → the next step slides in, or the card drops away.
// Closing it (×, Escape, the scrim) keeps everything unsigned — and cancels a Quit. On an earlier
// session that counts as "she still skips" (StudyController.skip: sent for her once it is > 24 h old).
// Not while a send is in flight: closing then let the send finish behind an unmounted card, whose
// leftover timer reported a second, completed outcome — App's stale cardDone (quitting: true) then
// quit the app after she chose "Not now — keep studying" (2026-10-01 review). So: close() is a no-op
// while sending, onDone fires at most once, and nothing is scheduled after unmount.
import { Check, LifeBuoy, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Dialog } from '../components/Dialog';
import { Button, IconButton } from '../components/ui';
import { useApp } from '../app/context';
import { plural } from '../lib/format';
import { prefersReducedMotion } from '../lib/motion';
import { MOODS, type Mood, type SignOffTarget } from '../lib/session';
import { describeTarget } from '../lib/signoff';
import { useStudy, useStudyState } from '../state/study';

const MOOD_LABELS: Record<Mood, string> = { '😄': 'Great', '🙂': 'Good', '😐': 'Okay', '😩': 'Tough' };
/** the "Sent ✓" moment before the card moves on */
const SENT_HOLD_MS = 650;
/** = --animate-leave (index.css) */
const LEAVE_MS = 180;

export interface SignOffOutcome {
  sent: number;
  /** walked to the end (vs. closed early) — Quit only stops the server then */
  completed: boolean;
}

interface Props {
  targets: SignOffTarget[];
  quitting: boolean;
  onDone: (outcome: SignOffOutcome) => void;
}

type Phase = 'edit' | 'sending' | 'sent' | 'leaving';

/** The primary button when the session already went to Rahul without her (StudyController 'gone'). */
const goneLabel = (last: boolean, quitting: boolean): string => (!last ? 'Next' : quitting ? 'Quit' : 'Done');

export function SignOffCard({ targets, quitting, onDone }: Props) {
  const { course, profile } = useApp();
  const study = useStudy();
  const { live } = useStudyState();
  const [step, setStep] = useState(0);
  const [note, setNote] = useState('');
  const [mood, setMood] = useState<Mood | null>(null);
  const [stuck, setStuck] = useState(false);
  const [phase, setPhase] = useState<Phase>('edit');
  const [error, setError] = useState<string | null>(null);
  /** this step's session already went to Rahul without her note (the 24 h rule) */
  const [gone, setGone] = useState(false);
  /** this step was sent: "Sent ✓" stays on the button through the exit */
  const [sentThisStep, setSentThisStep] = useState(false);
  const sent = useRef(0);
  const timers = useRef<number[]>([]);
  const alive = useRef(true);
  const finished = useRef(false);
  const noteId = useId();
  const moodLabel = useId();
  const titleId = useId();
  useEffect(() => {
    alive.current = true;
    return () => {
      // A timer scheduled AFTER this cleanup (a send resolving late) would never be cleared: later()
      // checks `alive` instead of trusting this list to be complete.
      alive.current = false;
      timers.current.forEach((t) => window.clearTimeout(t));
      timers.current = [];
    };
  }, []);
  // The 24 h rule must not send a session behind her back while this card asks about it.
  useEffect(() => study.hold(targets), [study, targets]);

  const target = targets[step] ?? targets[targets.length - 1] ?? ({ kind: 'note' } as const);
  // This session keeps growing behind the card while a video plays: show it as it is now.
  const shown: SignOffTarget = target.kind === 'live' && live !== null && live.id === target.session.id ? { kind: 'live', session: live } : target;
  const summary = describeTarget(shown, course, profile.name, Date.now());
  const lectureCount = summary.lectures.shown.length + summary.lectures.more;
  const last = step >= targets.length - 1;
  const connected = profile.journeyConnected;
  const hasNote = note.trim() !== '';
  const busy = phase !== 'edit';

  const later = (fn: () => void, ms: number): void => {
    if (!alive.current) return;
    timers.current.push(window.setTimeout(fn, ms));
  };

  const finish = (outcome: SignOffOutcome): void => {
    if (finished.current) return;
    finished.current = true;
    onDone(outcome);
  };

  const close = (completed: boolean): void => {
    // `phase` may be stale here (a timer from an earlier render calls next → close), so `finish` is
    // the real once-only guard; this check only keeps a send in flight from being abandoned.
    if (phase === 'leaving' || phase === 'sending') return;
    if (!completed) study.skip(target);
    setPhase('leaving');
    // the exit animation is motion (instant under reduced motion); the "Sent ✓" hold below is reading
    // time for feedback, so it stays either way
    later(() => finish({ sent: sent.current, completed }), prefersReducedMotion() ? 0 : LEAVE_MS);
  };

  const next = (): void => {
    if (last) {
      close(true);
      return;
    }
    setStep((n) => n + 1);
    setNote('');
    setMood(null);
    setStuck(false);
    setGone(false);
    setSentThisStep(false);
    setPhase('edit');
  };

  const send = async (withNote: boolean): Promise<void> => {
    if (busy) return;
    setPhase('sending');
    setError(null);
    const result = await study.signOff(target, { mood, note: withNote ? note : null, stuck });
    if (!alive.current) return;
    if (result === 'failed') {
      setPhase('edit');
      setError('Couldn’t hand it to the course app — is it still running? Try again.');
      return;
    }
    if (result === 'gone') {
      // Say so and wait for her: advancing would drop her note without a word.
      setPhase('edit');
      setGone(true);
      return;
    }
    if (result === 'skipped') {
      next();
      return;
    }
    sent.current++;
    setSentThisStep(true);
    setPhase('sent');
    later(next, SENT_HOLD_MS);
  };

  const primaryLabel = gone ? goneLabel(last, quitting) : quitting && last ? 'Sign off & quit' : connected ? 'Send to Rahul' : 'Sign off';
  const quietLabel =
    gone || !connected || target.kind === 'note' || hasNote
      ? null
      : summary.needsNote
        ? quitting && last
          ? 'Quit without sending'
          : 'Sign off without sending'
        : 'Send without a note';
  const showSent = phase === 'sent' || (phase === 'leaving' && sentThisStep);

  return (
    <Dialog
      open
      onClose={() => close(false)}
      labelledBy={titleId}
      enter="rise"
      leaving={phase === 'leaving'}
      className="max-h-[calc(100dvh-2rem)] max-w-lg overflow-y-auto"
    >
      <div data-signoff={target.kind} key={step} className={`p-6 ${step > 0 ? 'animate-step-next' : ''}`}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            {targets.length > 1 && (
              <p className="mb-1 text-xs font-medium tabular-nums text-ink-subtle">
                {step + 1} of {targets.length}
              </p>
            )}
            <h2 id={titleId} className="text-xl font-semibold text-ink">
              {summary.heading}
            </h2>
            {summary.question && <p className="mt-1 text-ink-muted">{summary.question}</p>}
          </div>
          <IconButton
            label={quitting ? 'Not now — keep studying' : 'Not now'}
            size="sm"
            className="-mr-2 -mt-1"
            disabled={phase === 'sending'}
            onClick={() => close(false)}
          >
            <X className="size-4" strokeWidth={1.5} />
          </IconButton>
        </div>

        {/* the auto summary: nothing for her to fill in */}
        {summary.studied !== null ? (
          <div className="mt-4 rounded-md bg-sunken px-4 py-3">
            <p className="text-sm text-ink-muted">
              <span className="font-semibold tabular-nums text-ink">{summary.studied}</span>
              {lectureCount > 0 && <> · {plural(lectureCount, 'lecture')}</>}
              {summary.section && <> · {summary.section}</>}
            </p>
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
          </div>
        ) : (
          <p className="mt-3 text-sm text-ink-muted">Nothing studied in the player since your last sign-off. Studied somewhere else? Tell him how it went.</p>
        )}

        {!connected ? (
          <p className="mt-5 text-sm text-ink">JS Journey isn’t connected, so this can’t reach Rahul. Connect it from the settings menu (top right).</p>
        ) : (
          <>
            <label htmlFor={noteId} className="mt-6 block text-sm font-medium text-ink">
              Note for Rahul
              {summary.needsNote && target.kind !== 'note' && <span className="font-normal text-ink-muted"> — under 5 min is only sent with a note</span>}
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
          </>
        )}

        {error && (
          <p role="alert" className="mt-4 text-sm text-ink">
            {error}
          </p>
        )}
        {gone && (
          <p role="alert" className="mt-4 text-sm text-ink">
            This session already went to Rahul without a note (it was over 24 h old), so your note wasn’t sent.
          </p>
        )}

        <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
          {quietLabel && (
            <Button variant="ghost" disabled={busy} onClick={() => void send(false)}>
              {quietLabel}
            </Button>
          )}
          {/* Busy (sending / Sent ✓ / leaving) = aria-disabled + no pointer events, NOT `disabled`: the
              disabled look (50 % opacity) made the exit read as "the send was undone". `disabled` is
              only for the real "needs a note" case. */}
          <Button
            variant="primary"
            data-control="signoff-primary"
            className={`min-w-36 ${busy ? 'pointer-events-none' : ''}`}
            disabled={!gone && connected && summary.needsNote && !hasNote}
            aria-disabled={busy || undefined}
            onClick={() => {
              if (busy) return;
              if (gone) next();
              else void send(true);
            }}
            aria-live="polite"
          >
            {showSent ? (
              <>
                <Check className="size-4 animate-check-in" strokeWidth={2.25} aria-hidden="true" />
                Sent
              </>
            ) : (
              primaryLabel
            )}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

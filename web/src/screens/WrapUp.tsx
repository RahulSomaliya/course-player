// Wrap-up card (journey-connected profile; End session or Quit): duration · lectures · section, a mood,
// an optional note. Send = with mood/note; Skip = still sends, mood/note null.
import { useId, useState } from 'react';
import type { Course } from '../../../shared/types';
import { Dialog } from '../components/Dialog';
import { Button } from '../components/ui';
import { formatDuration, plural } from '../lib/format';
import { MOODS, mainSection, type LiveSession, type Mood } from '../lib/session';

const MOOD_LABELS: Record<Mood, string> = { '😄': 'Great', '🙂': 'Good', '😐': 'Okay', '😩': 'Tough' };

interface Props {
  session: LiveSession;
  name: string;
  course: Course;
  quitting: boolean;
  onDone: (answer: { mood: Mood | null; note: string | null }) => void;
}

export function WrapUp({ session, name, course, quitting, onDone }: Props) {
  const [mood, setMood] = useState<Mood | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const noteId = useId();
  const moodLabel = useId();
  const sectionNumber = mainSection(session);
  const section = course.sections.find((s) => s.number === sectionNumber);
  const lectures = session.lecturesCompleted.length;

  const finish = (answer: { mood: Mood | null; note: string | null }): void => {
    if (busy) return;
    setBusy(true);
    onDone(answer);
  };

  return (
    <Dialog open onClose={() => finish({ mood: null, note: null })} labelledBy="wrapup-title" className="max-w-md">
      <div className="p-6">
        <h2 id="wrapup-title" className="text-xl font-semibold text-ink">
          Nice work, {name}
        </h2>
        <p className="mt-2 text-sm text-ink-muted">
          <span className="font-medium tabular-nums text-ink">{formatDuration(session.seconds)}</span>
          {' · '}
          {plural(lectures, 'lecture')} done
          {section && (
            <>
              {' · '}§{section.id} {section.title}
            </>
          )}
        </p>

        <p id={moodLabel} className="mt-6 text-sm font-medium text-ink">
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
                onClick={() => setMood(on ? null : m)}
                className={`flex h-16 flex-col items-center justify-center gap-0.5 rounded-md border text-2xl transition-transform duration-150 ease-out active:scale-95 ${
                  on ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-fill'
                }`}
              >
                <span aria-hidden="true">{m}</span>
                <span className={`text-[11px] font-medium ${on ? 'text-accent-ink' : 'text-ink-muted'}`}>{MOOD_LABELS[m]}</span>
              </button>
            );
          })}
        </div>

        <label htmlFor={noteId} className="mt-6 block text-sm font-medium text-ink">
          Note <span className="font-normal text-ink-muted">(optional)</span>
        </label>
        <textarea
          id={noteId}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={2000}
          rows={3}
          placeholder="What clicked, what didn’t…"
          className="mt-2 w-full resize-none rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-subtle"
        />

        <div className="mt-6 flex items-center justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={() => finish({ mood: null, note: null })}>
            Skip
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => finish({ mood, note })} data-autofocus>
            {quitting ? 'Send & quit' : 'Send'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

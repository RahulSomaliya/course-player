// Header: course title (left; on Watch the back link) · the study timer · menu · Quit (right).
// The timer (components/StudyTimer.tsx, spec v3 A4): "Start studying" with no session; while one runs a
// quiet "● 1h 23m" chip that reads "Sign off" on hover / focus. The menu holds theme, "Note to Rahul…"
// (a note-only update) and JS Journey — whose row says "course not recognised" when JS Journey does not
// know this copy's course id (JourneyStore.problem), never just "Connected".
import { Check, ChevronLeft, CircleAlert, Link2, MessageSquare, Monitor, Moon, Power, Settings2, Sun } from 'lucide-react';
import { useId, useRef, useState, type FormEvent } from 'react';
import type { Prefs } from '../../../shared/types';
import { useApp } from '../app/context';
import { ApiError, connectJourney, disconnectJourney } from '../lib/api';
import { withPrefs } from '../lib/progress';
import { hrefFor } from '../lib/router';
import { useJourney } from '../state/journey';
import { useProgress, useProgressStore } from '../state/progress';
import { useStudyState } from '../state/study';
import { HeaderTimer } from './StudyTimer';
import { Button, IconButton, useDismiss } from './ui';

export function Header({ back = false }: { back?: boolean }) {
  const { course } = useApp();
  return (
    // view-transition-name: the header switches instantly while Home morphs into Watch (index.css).
    <header className="sticky top-0 z-30 border-b border-line bg-canvas [view-transition-name:app-header]">
      <div className={`mx-auto flex h-14 items-center gap-3 px-4 md:px-6 ${back ? 'max-w-[1600px]' : 'max-w-[1148px]'}`}>
        <a href={hrefFor({ name: 'home' })} className="group -ml-1 flex min-w-0 items-center gap-1 rounded-md px-1 py-1">
          {back && <ChevronLeft className="size-5 shrink-0 text-ink-muted group-hover:text-ink" strokeWidth={1.5} aria-hidden="true" />}
          <span className="truncate text-[15px] font-semibold text-ink">{course.title}</span>
          {back && <span className="sr-only">— back to course home</span>}
        </a>
        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          <HeaderTimer />
          <Menu />
          <QuitButton />
        </div>
      </div>
    </header>
  );
}

/** Quit stops the server, and the Stopped page cannot start it again. With the timer running, Quit
 *  opens the sign-off card ("Send & quit") — that card is the confirmation. Otherwise it asks once
 *  (it sits next to the menu, and a misclick mid-lecture meant a trip to Finder). */
function QuitButton() {
  const { quit } = useApp();
  const unsigned = useStudyState().session !== null;
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), [trigger, panel], trigger);
  return (
    <div className="relative">
      <Button
        ref={trigger}
        variant="ghost"
        size="sm"
        onClick={() => (unsigned ? quit() : setOpen((o) => !o))}
        aria-expanded={unsigned ? undefined : open}
        aria-label="Quit the course player"
        className="px-2 sm:px-3"
      >
        <Power className="size-4" strokeWidth={1.5} aria-hidden="true" />
        <span className="hidden sm:inline">Quit</span>
      </Button>
      {open && (
        <div ref={panel} data-control="quit-confirm" className="absolute right-0 top-10 z-40 w-64 animate-pop-in rounded-lg border border-line bg-raised p-4 shadow-e2">
          <p className="text-sm font-semibold text-ink">Quit the course player?</p>
          <p className="mt-1 text-sm text-ink-muted">Your progress is saved.</p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-4 w-full"
            onClick={() => {
              setOpen(false);
              quit();
            }}
          >
            Quit
          </Button>
        </div>
      )}
    </div>
  );
}

const THEMES: { value: Prefs['theme']; label: string; Icon: typeof Sun }[] = [
  { value: null, label: 'System', Icon: Monitor },
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
];

function Menu() {
  const { openNote } = useApp();
  const store = useProgressStore();
  const theme = useProgress((s) => s.prefs.theme);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), [trigger, panel], trigger);
  const themeLabel = useId();

  return (
    <div className="relative">
      <IconButton ref={trigger} label="Settings — theme and JS Journey" size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="true">
        <Settings2 className="size-4" strokeWidth={1.5} />
      </IconButton>
      {open && (
        <div ref={panel} className="absolute right-0 top-10 z-40 w-[min(20rem,calc(100vw-2rem))] animate-pop-in rounded-lg border border-line bg-raised shadow-e2">
          <div className="p-2">
            {/* a note-only update: something she studied away from the player (no time logged) */}
            <button
              type="button"
              data-control="note-to-rahul"
              onClick={() => {
                setOpen(false);
                openNote();
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-ink hover:bg-fill"
            >
              <MessageSquare className="size-4 text-ink-muted" strokeWidth={1.5} aria-hidden="true" />
              Note to Rahul…
            </button>
          </div>
          <div className="border-t border-line p-4">
            <p id={themeLabel} className="mb-2 text-xs font-medium text-ink-muted">
              Theme
            </p>
            <div role="radiogroup" aria-labelledby={themeLabel} className="grid grid-cols-3 gap-1 rounded-md bg-fill p-1">
              {THEMES.map(({ value, label, Icon }) => {
                const on = theme === value;
                return (
                  <button
                    key={label}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => store.update((s, now) => withPrefs(s, { theme: value }, now))}
                    className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-[6px] text-sm ${
                      on ? 'bg-control font-medium text-ink shadow-e1' : 'text-ink-muted hover:text-ink'
                    }`}
                  >
                    <Icon className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="border-t border-line p-4">
            <JourneyRow />
          </div>
        </div>
      )}
    </div>
  );
}

function JourneyRow() {
  const { profile, updateProfile } = useApp();
  const { problem } = useJourney();
  const [editing, setEditing] = useState(false);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const errorId = useId();

  if (profile.journeyConnected) {
    return (
      <>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">JS Journey</p>
          {problem === null ? (
            <p className="mt-0.5 inline-flex items-center gap-1 text-sm text-ink-muted">
              <Check className="size-3.5 text-accent" strokeWidth={2} aria-hidden="true" />
              Connected
            </p>
          ) : (
            <p data-journey="course-not-recognised" className="mt-0.5 inline-flex items-center gap-1 text-sm text-ink">
              <CircleAlert className="size-3.5 text-ink-muted" strokeWidth={1.75} aria-hidden="true" />
              Course not recognised
            </p>
          )}
        </div>
        <button
          type="button"
          disabled={busy}
          className="text-sm text-ink-muted underline-offset-2 hover:text-ink hover:underline"
          onClick={async () => {
            setBusy(true);
            try {
              updateProfile(await disconnectJourney(profile.id));
            } catch (err) {
              console.error('[journey] disconnect failed', err);
              setError(err instanceof Error ? err.message : 'Could not disconnect.');
            } finally {
              setBusy(false);
            }
          }}
        >
          Disconnect
        </button>
      </div>
      {/* the server's sentence names the id ("… this copy's course id is wrong; ask Rahul") */}
      {problem !== null && <p className="mt-2 text-sm text-ink-muted">{problem.error}</p>}
      {error && (
        <p role="alert" className="mt-2 text-sm text-ink">
          {error}
        </p>
      )}
      </>
    );
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-ink hover:bg-fill"
      >
        <Link2 className="size-4 text-ink-muted" strokeWidth={1.5} aria-hidden="true" />
        Connect JS Journey…
      </button>
    );
  }

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const value = link.trim();
    if (!/^https?:\/\/[^/]+\/m\/[^/?#]+\/?$/.test(value)) {
      setError('Paste the student link — it looks like https://…/m/…');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      updateProfile(await connectJourney(profile.id, value));
      setEditing(false);
      setLink('');
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 400
          ? 'That link doesn’t look right — copy it again from JS Journey.'
          : err instanceof ApiError && err.status === 502
            ? 'JS Journey didn’t accept that link.'
            : err instanceof ApiError && err.problem !== null
              ? err.problem.error // 409: the link is fine, this copy's course id is not — the sentence names it
              : 'Couldn’t reach JS Journey. Check the internet connection and try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate>
      <label htmlFor={inputId} className="text-sm font-medium text-ink">
        JS Journey student link
      </label>
      <input
        id={inputId}
        type="url"
        autoFocus
        value={link}
        onChange={(e) => {
          setLink(e.target.value);
          setError(null);
        }}
        placeholder="https://…/m/…"
        aria-invalid={error !== null}
        aria-describedby={error ? errorId : undefined}
        className="mt-2 h-10 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink placeholder:text-ink-subtle aria-[invalid=true]:border-ink-muted"
      />
      {error && (
        <p id={errorId} role="alert" className="mt-2 text-sm text-ink">
          {error}
        </p>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" type="submit" disabled={busy || link.trim() === ''}>
          {busy ? 'Checking…' : 'Connect'}
        </Button>
      </div>
    </form>
  );
}

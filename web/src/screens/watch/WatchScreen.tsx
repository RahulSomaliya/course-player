// Watch `#/watch/<id>`: player (or article / pdf) + details on the left, the current section on the
// right (SectionPanel; under the details below 1024 px). `T` or the panel button = theatre (sidebar hidden).
import { Check, ChevronLeft, ChevronRight, ExternalLink, FileText, Keyboard, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Lecture, Resource, Section } from '../../../../shared/types';
import { useApp } from '../../app/context';
import { Header } from '../../components/Header';
import { Button, IconButton, LinkButton, Overline, buttonClass } from '../../components/ui';
import { neighbours } from '../../lib/course';
import { formatDuration } from '../../lib/format';
import { isEditableTarget, keyToAction } from '../../lib/keys';
import { withLast, withPos, withPrefs } from '../../lib/progress';
import { hrefFor, navigate } from '../../lib/router';
import { browserStore, readString, writeString } from '../../lib/storage';
import { Player, type PlayerHandle } from '../../player/Player';
import { useJourney } from '../../state/journey';
import { useProgress, useProgressStore } from '../../state/progress';
import { useStudy } from '../../state/study';
import { ArticleBody, PdfFrame, PdfSheet } from './LectureViews';
import { SectionPanel } from './SectionPanel';
import { ShortcutSheet } from './ShortcutSheet';

const THEATRE_KEY = 'cp:theatre'; // a per-browser convenience, not progress

export function WatchScreen({ id }: { id: string }) {
  const { index } = useApp();
  const ref = index.byId.get(id);
  if (!ref) {
    return (
      <>
        <Header back />
        <main className="mx-auto max-w-xl px-4 py-24 text-center">
          <h1 className="text-2xl font-semibold text-ink">This lecture isn’t in the course</h1>
          <p className="mt-3 text-ink-muted">The file may have been renamed or moved on the SSD.</p>
          <LinkButton href={hrefFor({ name: 'home' })} variant="primary" className="mt-8">
            Back to the course
          </LinkButton>
        </main>
      </>
    );
  }
  // keyed: every lecture gets fresh state (resume position, article fetch, player)
  return <Watch key={ref.lecture.id} lecture={ref.lecture} section={ref.section} />;
}

function Watch({ lecture, section }: { lecture: Lecture; section: Section }) {
  const { index } = useApp();
  const store = useProgressStore();
  const study = useStudy();
  const { status } = useJourney();
  const prefs = useProgress((s) => s.prefs);
  const progress = useProgress((s) => s.lectures[lecture.id]);
  const { prev, next } = neighbours(index, lecture.id);
  const nextLecture = next === null ? null : (index.byId.get(next)?.lecture ?? null);
  const [theatre, setTheatre] = useState(() => readString(browserStore(), THEATRE_KEY) === '1');
  const [help, setHelp] = useState(false);
  const [pdf, setPdf] = useState<Resource | null>(null);
  const player = useRef<PlayerHandle>(null);
  const isVideo = lecture.kind === 'video';
  const done = progress?.done ?? false;
  // The resume position is read once per lecture — later saves must not re-seek the playing video.
  // Safe to read at mount: App.tsx mounts no screen before hydrate, so this is the SSD-merged `pos`.
  const [startAt] = useState(() => progress?.pos ?? 0);

  const toggleTheatre = useCallback(() => {
    setTheatre((t) => {
      writeString(browserStore(), THEATRE_KEY, t ? null : '1');
      return !t;
    });
  }, []);

  // Opening a lecture: remember it for Continue, tell the study ticker what is open, start at the top.
  // An article / pdf lecture starts the study timer if none runs (spec v3: auto-start; a video starts it
  // when it plays — onPlayingChange). This mount effect runs BEFORE ProfileApp's (parent) effect, so it
  // must never run before the SSD copy is read — App.tsx renders no screen until store.hydrate() settles.
  useEffect(() => {
    store.update((s, now) => withLast(s, lecture.id, now));
    study.setActivity({ lectureId: lecture.id, playing: false, reading: !isVideo });
    if (!isVideo) study.autoStart();
    window.scrollTo(0, 0);
    return () => study.setActivity({ lectureId: null, playing: false, reading: false });
  }, [lecture.id, isVideo, store, study]);

  // Closing the tab mid-video: save the exact position (ProgressStore then flushes on pagehide).
  useEffect(() => {
    if (!isVideo) return;
    const onHide = (): void => {
      const pos = player.current?.position() ?? 0;
      if (pos > 0) store.update((s, now) => withPos(s, lecture.id, pos, now));
    };
    // capture: on the window target capture listeners run first, so this lands before ProfileApp's
    // pagehide flush (App.tsx) sends the keepalive PUT.
    window.addEventListener('pagehide', onHide, { capture: true });
    return () => window.removeEventListener('pagehide', onHide, { capture: true });
  }, [isVideo, lecture.id, store]);

  const goTo = useCallback((target: string | null) => target !== null && navigate({ name: 'watch', id: target }), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || isEditableTarget(e.target)) return;
      if (document.querySelector('[data-dialog="open"]')) return; // an open dialog owns the keyboard
      const action = keyToAction(e);
      if (action === null) return;
      const target = e.target instanceof Element ? e.target : null;
      const inPlayer = Boolean(target?.closest('[data-player]'));
      // Space on a focused button/link outside the player keeps its native meaning (press it).
      if (e.key === ' ' && !inPlayer && target?.closest('button, a, [role="radio"]')) return;
      switch (action.type) {
        case 'next':
          goTo(next);
          break;
        case 'prev':
          goTo(prev);
          break;
        case 'theatre':
          toggleTheatre();
          break;
        case 'help':
          // Dialogs are portaled to <body>, which is not shown while the player is fullscreen.
          if (document.fullscreenElement) document.exitFullscreen().catch((err: unknown) => console.error('[watch] exit fullscreen failed', err));
          setHelp(true);
          break;
        default:
          if (!isVideo) return; // articles: Space/arrows scroll the page as usual
          player.current?.handle(action);
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goTo, next, prev, toggleTheatre, isVideo]);

  const onPrefs = useCallback((patch: Partial<typeof prefs>) => store.update((s, now) => withPrefs(s, patch, now)), [store]);
  const onPosition = useCallback((pos: number) => store.update((s, now) => withPos(s, lecture.id, pos, now)), [store, lecture.id]);
  const onComplete = useCallback(() => {
    if (!store.get().lectures[lecture.id]?.done) study.setDone(lecture.id, true);
  }, [store, study, lecture.id]);
  // The `play` event (Player onPlay — not `playing`, which also fires after a buffering stall): a video she
  // plays with no session running starts the timer. Right after Send a video still playing does NOT
  // restart it — only her next play does.
  const onPlayingChange = useCallback(
    (playing: boolean) => {
      study.setActivity({ playing });
      if (playing) study.autoStart();
    },
    [study],
  );

  const overline = `${section.part ? `Part ${section.part.number}` : `Section ${section.id}`} · Lecture ${lecture.number}`;

  const details = (
    <div className={isVideo ? 'mt-6' : 'mt-10'}>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          aria-pressed={done}
          onClick={() => study.setDone(lecture.id, !done)}
          className={done ? 'border-transparent! bg-accent-soft! text-accent-ink!' : ''}
        >
          <Check className="size-4" strokeWidth={done ? 2.25 : 1.5} aria-hidden="true" />
          {done ? 'Done' : 'Mark as done'}
        </Button>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="md" disabled={prev === null} onClick={() => goTo(prev)} aria-label="Previous lecture (Shift+P)">
            <ChevronLeft className="size-4" strokeWidth={1.5} aria-hidden="true" />
            <span className="hidden sm:inline">Previous</span>
          </Button>
          <Button variant="ghost" size="md" disabled={next === null} onClick={() => goTo(next)} aria-label="Next lecture (Shift+N)">
            <span className="hidden sm:inline">Next</span>
            <ChevronRight className="size-4" strokeWidth={1.5} aria-hidden="true" />
          </Button>
          <IconButton label="Keyboard shortcuts (?)" onClick={() => setHelp(true)} desktopOnly>
            <Keyboard className="size-4" strokeWidth={1.5} />
          </IconButton>
          <IconButton label={theatre ? 'Show the section (T)' : 'Hide the section (T)'} onClick={toggleTheatre} aria-pressed={theatre}>
            {theatre ? <PanelRightOpen className="size-4" strokeWidth={1.5} /> : <PanelRightClose className="size-4" strokeWidth={1.5} />}
          </IconButton>
        </div>
      </div>
      {lecture.resources.length > 0 && (
        <ul className="mt-6 flex flex-wrap gap-2" aria-label="Resources">
          {lecture.resources.map((r) => (
            <li key={r.href}>
              {r.kind === 'link' ? (
                <a href={r.href} target="_blank" rel="noopener noreferrer" className={buttonClass('secondary', 'sm', 'rounded-full!')}>
                  {r.title}
                  <ExternalLink className="size-3.5 text-ink-muted" strokeWidth={1.5} aria-hidden="true" />
                </a>
              ) : (
                <button type="button" onClick={() => setPdf(r)} className={buttonClass('secondary', 'sm', 'rounded-full!')}>
                  <FileText className="size-3.5 text-ink-muted" strokeWidth={1.5} aria-hidden="true" />
                  {r.title}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  const heading = (
    <div className={isVideo ? 'mt-6' : ''}>
      <Overline>{overline}</Overline>
      {/* Articles: the hero size, so the title clearly outranks the course HTML's own headings (index.css .article). */}
      <h1 className={`mt-2 text-balance font-semibold text-ink ${lecture.kind === 'article' ? 'text-3xl' : 'text-2xl'}`}>{lecture.title}</h1>
      {isVideo && <p className="sr-only">Length {formatDuration(lecture.duration)}</p>}
    </div>
  );

  return (
    <>
      <Header back />
      <main className="mx-auto max-w-[1600px] px-4 pb-24 pt-4 md:px-6 md:pt-6">
        <div className={theatre ? '' : 'lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-8'}>
          <div className="min-w-0">
            {isVideo ? (
              // Theatre: ONE column for the player and its heading/details, so they share a left edge
              // (two different max-widths put the title ~94 px inside the player's edge).
              <div className={theatre ? 'mx-auto max-w-[calc((100vh-11rem)*16/9)]' : ''}>
                <Player
                  key={lecture.id}
                  ref={player}
                  lecture={lecture}
                  overline={overline}
                  startAt={startAt}
                  prefs={prefs}
                  onPrefs={onPrefs}
                  onPosition={onPosition}
                  onComplete={onComplete}
                  onPlayingChange={onPlayingChange}
                  next={nextLecture}
                  onNext={() => goTo(next)}
                />
                {heading}
                {details}
              </div>
            ) : lecture.kind === 'article' ? (
              <article className="mx-auto max-w-[68ch] pt-6 md:pt-10">
                {heading}
                <div className="mt-8">
                  <ArticleBody lecture={lecture} />
                </div>
                <div className="mt-12 border-t border-line pt-2">{details}</div>
              </article>
            ) : (
              <div className="pt-2">
                {heading}
                <div className="mt-4 flex justify-end">
                  <LinkButton href={lecture.src} target="_blank" rel="noopener noreferrer" variant="ghost" size="sm">
                    <ExternalLink className="size-4" strokeWidth={1.5} aria-hidden="true" />
                    Open in new tab
                  </LinkButton>
                </div>
                <PdfFrame src={lecture.src} title={lecture.title} className="mt-2 h-[calc(100vh-14rem)] min-h-96" />
                {details}
              </div>
            )}
          </div>
          {!theatre && <SectionPanel currentId={lecture.id} plan={status} />}
        </div>
      </main>
      <ShortcutSheet open={help} onClose={() => setHelp(false)} />
      <PdfSheet resource={pdf} onClose={() => setPdf(null)} />
    </>
  );
}

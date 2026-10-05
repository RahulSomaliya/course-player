// The one primary action on Home: continue (or start) the next lecture. Beside it, while no study
// session runs, "Start studying" (secondary: it starts the wall-clock timer without opening a lecture —
// coding, GitHub, the course's own exercises; spec v3 decision 1). Playing a lecture starts it anyway.
// Motion: following either Continue link morphs the thumbnail into the player (View Transitions,
// lib/motion.ts). The thumbnail and Player's box share `view-transition-name: lecture-media` — no other
// element may carry that name while either is on screen, or the browser skips the transition.
// The still frame fades in once decoded (HeroFrame): the <video> is recreated on every Home mount, and
// from the USB SSD the box sat solid black, then the frame popped in (2026-10-01 review).
import { FileText, Play } from 'lucide-react';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { Lecture, LectureProgress, Section } from '../../../../shared/types';
import { StartStudying } from '../../components/StudyTimer';
import { buttonClass, Overline, ProgressLine } from '../../components/ui';
import { formatClock, formatDuration } from '../../lib/format';
import { navigateWithMorph } from '../../lib/motion';
import { hrefFor } from '../../lib/router';
import { useStudyState } from '../../state/study';

interface Props {
  lecture: Lecture | null;
  section: Section | null;
  progress: LectureProgress | undefined;
  /** nothing studied yet on this profile */
  fresh: boolean;
}

/** A still frame for the hero: the saved position, or a moment past the intro for a new lecture. */
function frameAt(lecture: Lecture, pos: number): number {
  if (pos > 5) return pos;
  return Math.min(30, lecture.duration * 0.2);
}

export function ContinueHero({ lecture, section, progress, fresh }: Props) {
  const timing = useStudyState().session !== null;
  if (lecture === null || section === null) {
    return (
      <section aria-labelledby="hero-title" className="rounded-lg border border-line bg-surface px-6 py-12 text-center shadow-e1 sm:px-12">
        <Overline>Course complete</Overline>
        <h2 id="hero-title" className="mt-3 text-3xl font-semibold text-ink">
          You’ve finished every lecture.
        </h2>
        <p className="mx-auto mt-3 max-w-md text-ink-muted">Revisit any section below — your progress stays as it is.</p>
        {!timing && (
          <div className="mt-8 flex justify-center">
            <StartStudying size="hero" />
          </div>
        )}
      </section>
    );
  }

  const pos = progress?.pos ?? 0;
  const resumable = lecture.kind === 'video' && pos > 10 && pos < lecture.duration - 15;
  const href = hrefFor({ name: 'watch', id: lecture.id });
  const label = resumable ? `Resume ${formatClock(pos)}` : 'Start';
  const fraction = lecture.duration > 0 ? pos / lecture.duration : 0;
  const left = lecture.duration - pos;
  const go = (e: MouseEvent<HTMLAnchorElement>): void => {
    // a new-tab / modified click keeps the browser's own behaviour
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigateWithMorph({ name: 'watch', id: lecture.id });
  };

  return (
    <section aria-labelledby="hero-title" className="grid items-center gap-6 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] md:gap-10">
      <a
        href={href}
        onClick={go}
        tabIndex={-1}
        aria-hidden="true"
        data-morph="thumbnail"
        style={{ viewTransitionName: 'lecture-media' }}
        className="group relative block aspect-video overflow-hidden rounded-lg bg-player shadow-e1"
      >
        {lecture.kind === 'video' ? (
          <HeroFrame key={lecture.id} src={`${lecture.src}#t=${frameAt(lecture, pos).toFixed(1)}`} />
        ) : (
          <span className="flex size-full items-center justify-center text-player-ink-muted">
            <FileText className="size-12" strokeWidth={1} />
          </span>
        )}
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="flex size-16 items-center justify-center rounded-full bg-player-scrim text-player-ink transition-transform duration-200 ease-out group-hover:scale-105">
            <Play className="ml-1 size-7 fill-current" strokeWidth={1.5} />
          </span>
        </span>
      </a>
      <div className="min-w-0">
        <Overline>{fresh ? 'Start the course' : 'Continue'}</Overline>
        <h2 id="hero-title" className="mt-3 text-balance text-2xl font-semibold text-ink sm:text-3xl">
          {lecture.title}
        </h2>
        <p className="mt-2 text-ink-muted">
          Section {section.id} · {section.title}
        </p>
        {resumable && (
          <div className="mt-6 flex items-center gap-3">
            <ProgressLine value={fraction * 100} className="w-full max-w-60" label="Watched" />
            <span className="shrink-0 text-sm tabular-nums text-ink-muted">{formatDuration(left)} left</span>
          </div>
        )}
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <a href={href} onClick={go} data-control="continue" className={buttonClass('primary', 'lg')}>
            <Play className="size-4 fill-current" strokeWidth={1.5} aria-hidden="true" />
            <span className="tabular-nums">{label}</span>
          </a>
          {!timing && <StartStudying size="hero" />}
        </div>
      </div>
    </section>
  );
}

/** The still frame: transparent over the `bg-player` box until its first frame is decoded, then a
 *  200 ms fade (instant under reduced motion — index.css). Keyed by lecture, so a new one fades again. */
function HeroFrame({ src }: { src: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    // already decoded before React attached onLoadedData (a cached frame)
    if ((video.current?.readyState ?? 0) >= HTMLMediaElement.HAVE_CURRENT_DATA) setReady(true);
  }, []);
  return (
    <video
      ref={video}
      data-ready={ready ? 'true' : 'false'}
      className={`size-full object-cover transition-opacity duration-200 ease-out ${ready ? 'opacity-100' : 'opacity-0'}`}
      src={src}
      preload="metadata"
      muted
      playsInline
      disablePictureInPicture
      onLoadedData={() => setReady(true)}
    />
  );
}

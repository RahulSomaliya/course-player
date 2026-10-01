// The one primary action on Home: continue (or start) the next lecture.
import { FileText, Play } from 'lucide-react';
import type { Lecture, LectureProgress, Section } from '../../../../shared/types';
import { buttonClass, Overline, ProgressLine } from '../../components/ui';
import { formatClock, formatDuration } from '../../lib/format';
import { hrefFor } from '../../lib/router';

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
  if (lecture === null || section === null) {
    return (
      <section aria-labelledby="hero-title" className="rounded-lg border border-line bg-surface px-6 py-12 text-center shadow-e1 sm:px-12">
        <Overline>Course complete</Overline>
        <h2 id="hero-title" className="mt-3 text-3xl font-semibold text-ink">
          You’ve finished every lecture.
        </h2>
        <p className="mx-auto mt-3 max-w-md text-ink-muted">Revisit any section below — your progress stays as it is.</p>
      </section>
    );
  }

  const pos = progress?.pos ?? 0;
  const resumable = lecture.kind === 'video' && pos > 10 && pos < lecture.duration - 15;
  const href = hrefFor({ name: 'watch', id: lecture.id });
  const label = resumable ? `Resume ${formatClock(pos)}` : 'Start';
  const fraction = lecture.duration > 0 ? pos / lecture.duration : 0;
  const left = lecture.duration - pos;

  return (
    <section aria-labelledby="hero-title" className="grid items-center gap-6 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] md:gap-10">
      <a
        href={href}
        tabIndex={-1}
        aria-hidden="true"
        className="group relative block aspect-video overflow-hidden rounded-lg bg-player shadow-e1"
      >
        {lecture.kind === 'video' ? (
          <video
            key={lecture.id}
            className="size-full object-cover"
            src={`${lecture.src}#t=${frameAt(lecture, pos).toFixed(1)}`}
            preload="metadata"
            muted
            playsInline
            disablePictureInPicture
          />
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
        <a href={href} className={buttonClass('primary', 'lg', 'mt-8')}>
          <Play className="size-4 fill-current" strokeWidth={1.5} aria-hidden="true" />
          <span className="tabular-nums">{label}</span>
        </a>
      </div>
    </section>
  );
}

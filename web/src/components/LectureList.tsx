// The lecture rows of one section: ✓ done / current dot / plain, title, resource count, duration.
// Shared by the home course content (inside an open section) and the Watch sidebar.
import { FileText, Paperclip } from 'lucide-react';
import type { Lecture, LectureProgress, Section } from '../../../shared/types';
import { formatDuration, plural } from '../lib/format';
import { hrefFor } from '../lib/router';
import { LectureMark } from './ui';

/** Rows rise in with a 15 ms stagger when their section opens; capped so long sections stay snappy. */
const STAGGER_MS = 15;
const STAGGER_ROWS = 12;

interface Props {
  section: Section;
  lectures: Record<string, LectureProgress>;
  /** the Continue lecture (home) or the open lecture (Watch) */
  currentId: string | null;
  /** the section opened just now (Collapse) — rows rise in */
  entering?: boolean;
  /** Watch: the open lecture is the page itself */
  currentIsPage?: boolean;
  className?: string;
}

export function LectureList({ section, lectures, currentId, entering = false, currentIsPage = false, className = '' }: Props) {
  return (
    <ul className={className}>
      {section.lectures.map((l, i) => (
        <LectureRow
          key={l.id}
          lecture={l}
          done={lectures[l.id]?.done ?? false}
          current={l.id === currentId}
          currentIsPage={currentIsPage}
          delay={entering ? Math.min(i, STAGGER_ROWS - 1) * STAGGER_MS : null}
        />
      ))}
    </ul>
  );
}

function LectureRow({
  lecture,
  done,
  current,
  currentIsPage,
  delay,
}: {
  lecture: Lecture;
  done: boolean;
  current: boolean;
  currentIsPage: boolean;
  delay: number | null;
}) {
  const status = done ? 'done' : current ? 'current' : 'not started';
  return (
    <li className={delay === null ? '' : 'animate-row-in'} style={delay === null ? undefined : { animationDelay: `${delay}ms` }}>
      <a
        href={hrefFor({ name: 'watch', id: lecture.id })}
        aria-current={current ? (currentIsPage ? 'page' : 'step') : undefined}
        data-lecture={lecture.id}
        className={`flex items-start gap-3 rounded-md px-2 py-2 hover:bg-fill ${current && currentIsPage ? 'bg-fill' : ''}`}
      >
        <span className="pt-px">
          <LectureMark state={done ? 'done' : current ? 'current' : 'plain'} />
        </span>
        <span className="sr-only">{status}: </span>
        <span className={`min-w-0 flex-1 text-sm text-ink ${current ? 'font-medium' : ''}`}>
          <span className="tabular-nums text-ink-subtle">{lecture.number}.</span> {lecture.title}
        </span>
        <span className="flex shrink-0 items-center gap-2 pt-px text-xs tabular-nums text-ink-subtle">
          {lecture.resources.length > 0 && (
            <span className="inline-flex items-center gap-0.5" title={plural(lecture.resources.length, 'resource')}>
              <Paperclip className="size-3" strokeWidth={1.5} aria-hidden="true" />
              {lecture.resources.length}
              <span className="sr-only"> {lecture.resources.length === 1 ? 'resource' : 'resources'}</span>
            </span>
          )}
          {lecture.kind === 'video' ? (
            formatDuration(lecture.duration) === '0m' ? '<1m' : formatDuration(lecture.duration)
          ) : (
            <span className="inline-flex items-center gap-1">
              <FileText className="size-3" strokeWidth={1.5} aria-hidden="true" />
              {lecture.kind === 'article' ? 'Article' : 'PDF'}
            </span>
          )}
        </span>
      </a>
    </li>
  );
}

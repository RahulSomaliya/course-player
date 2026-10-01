// "Course content": section rows that expand into lecture lists. Part folders ("Part 1 - React
// Fundamentals (4 Projects)") are quiet group headings with their lectures beneath, never rows.
// Used on Home (variant "page") and as the Watch sidebar (variant "sidebar").
import { ChevronDown, FileText, Paperclip } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import type { Lecture, LectureProgress, Section } from '../../../shared/types';
import { useApp } from '../app/context';
import { sectionProgress } from '../lib/course';
import { formatDuration, plural } from '../lib/format';
import { hrefFor } from '../lib/router';
import { useProgress } from '../state/progress';
import { LectureStatus, ProgressLine } from './ui';

type Variant = 'page' | 'sidebar';
type Lectures = Record<string, LectureProgress>;

interface Props {
  variant: Variant;
  /** this lecture's section starts expanded (and, in the sidebar, the lecture is highlighted + scrolled to) */
  currentId: string | null;
}

export function CourseContent({ variant, currentId }: Props) {
  const { course, index } = useApp();
  const lectures = useProgress((s) => s.lectures);
  const currentSection = currentId === null ? null : (index.byId.get(currentId)?.section.id ?? null);
  const [open, setOpen] = useState<Set<string>>(() => new Set(currentSection ? [currentSection] : []));
  const list = useRef<HTMLDivElement>(null);

  // Following a lecture change (sidebar Next / Up next), open its section too.
  useEffect(() => {
    if (currentSection) setOpen((prev) => (prev.has(currentSection) ? prev : new Set(prev).add(currentSection)));
  }, [currentSection]);

  // Sidebar: bring the current lecture into view inside the sidebar's own scroller only — never the
  // page (scrollIntoView would also scroll the window and yank the player off-screen).
  // Lands on a boundary: the current section's header at the top edge, or — when the lecture sits too
  // deep in a long section for that — the first row a third of the way up. (`rowTop − height/3` alone
  // cut a row in half under the "Course content" header.) Re-runs when the current section OPENS, not on
  // every toggle: depending on the whole `open` set yanked the list back while browsing other sections.
  const currentOpen = currentSection !== null && open.has(currentSection);
  useEffect(() => {
    if (variant !== 'sidebar' || currentId === null) return;
    const root = list.current;
    const scroller = root?.closest<HTMLElement>('[data-scroller]');
    const row = root?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!root || !scroller || !row || scroller.scrollHeight <= scroller.clientHeight) return;
    const origin = scroller.getBoundingClientRect().top - scroller.scrollTop;
    const offset = (el: Element): number => el.getBoundingClientRect().top - origin;
    const rowTop = offset(row);
    const head = row.closest('[data-section]')?.querySelector('[data-section-head]');
    let top = head ? offset(head) : rowTop;
    if (rowTop + row.offsetHeight > top + scroller.clientHeight) {
      const want = rowTop - scroller.clientHeight / 3;
      const edges = [...root.querySelectorAll('[data-section-head], li > a')].map(offset);
      top = edges.find((t) => t >= want) ?? rowTop;
    }
    scroller.scrollTop = Math.max(0, top);
  }, [variant, currentId, currentOpen]);

  const toggle = (id: string): void =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div ref={list} className={variant === 'page' ? '' : 'pb-6'}>
      {course.sections.map((s) =>
        s.part ? (
          <PartGroup key={s.id} section={s} lectures={lectures} variant={variant} currentId={currentId} />
        ) : (
          <SectionRow
            key={s.id}
            section={s}
            lectures={lectures}
            variant={variant}
            currentId={currentSection === s.id ? currentId : null}
            open={open.has(s.id)}
            onToggle={toggle}
          />
        ),
      )}
    </div>
  );
}

function PartGroup({ section, lectures, variant, currentId }: { section: Section; lectures: Lectures; variant: Variant; currentId: string | null }) {
  const part = section.part as NonNullable<Section['part']>;
  const projects = part.projects === null ? '' : ` · ${plural(part.projects, 'project')}`;
  return (
    <div data-section className={variant === 'page' ? 'pb-2 pt-10' : 'pb-1 pt-6'}>
      <p data-section-head className={`text-xs font-semibold uppercase tracking-[0.08em] text-ink-muted ${variant === 'page' ? 'px-2' : 'px-4'}`}>
        Part {part.number} · {section.title}
        <span className="font-medium text-ink-subtle">{projects}</span>
      </p>
      <ul className={variant === 'page' ? 'mt-2' : 'mt-1'}>
        {section.lectures.map((l) => (
          <LectureRow key={l.id} lecture={l} progress={lectures[l.id]} variant={variant} current={l.id === currentId} />
        ))}
      </ul>
    </div>
  );
}

const SectionRow = memo(function SectionRow({
  section,
  lectures,
  variant,
  currentId,
  open,
  onToggle,
}: {
  section: Section;
  lectures: Lectures;
  variant: Variant;
  currentId: string | null;
  open: boolean;
  onToggle: (id: string) => void;
}) {
  const { done, total } = sectionProgress(section, lectures);
  const pct = total === 0 ? 0 : (done / total) * 100;
  const panelId = `section-${section.id}-${variant}`;
  const page = variant === 'page';
  return (
    <div data-section className={page ? 'border-b border-line' : ''}>
      <h3 data-section-head>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => onToggle(section.id)}
          className={`group flex w-full items-start gap-3 text-left hover:bg-fill ${page ? 'rounded-md px-2 py-4' : 'px-4 py-3'}`}
        >
          <span className="w-6 shrink-0 pt-px text-sm tabular-nums text-ink-subtle">{section.id}</span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className={`font-medium text-ink ${page ? 'text-base' : 'text-sm'}`}>{section.title}</span>
              {section.optional && (
                <span className="rounded-full border border-line px-2 py-px text-[11px] font-medium leading-4 text-ink-muted">Optional</span>
              )}
            </span>
            <span className="mt-2 flex items-center gap-3">
              <ProgressLine value={pct} className={page ? 'w-32 sm:w-48' : 'w-20'} />
              <span className="text-xs tabular-nums text-ink-muted">
                {done} / {total}
                <span className="text-ink-subtle"> · {formatDuration(section.duration)}</span>
              </span>
            </span>
          </span>
          <ChevronDown
            className={`mt-0.5 size-4 shrink-0 text-ink-subtle transition-transform duration-200 ease-out group-hover:text-ink-muted ${open ? 'rotate-180' : ''}`}
            strokeWidth={1.5}
            aria-hidden="true"
          />
        </button>
      </h3>
      <ul id={panelId} hidden={!open} className={page ? 'pb-4 pl-9' : 'pb-2'}>
        {open &&
          section.lectures.map((l) => (
            <LectureRow key={l.id} lecture={l} progress={lectures[l.id]} variant={variant} current={l.id === currentId} />
          ))}
      </ul>
    </div>
  );
});

function LectureRow({ lecture, progress, variant, current }: { lecture: Lecture; progress: LectureProgress | undefined; variant: Variant; current: boolean }) {
  const done = progress?.done ?? false;
  const fraction = lecture.duration > 0 ? (progress?.pos ?? 0) / lecture.duration : 0;
  const page = variant === 'page';
  const status = done ? 'done' : fraction > 0.02 ? 'partly watched' : 'not started';
  return (
    <li>
      <a
        href={hrefFor({ name: 'watch', id: lecture.id })}
        aria-current={current ? 'page' : undefined}
        className={`group flex items-start gap-3 hover:bg-fill ${page ? 'rounded-md px-2 py-2' : 'px-4 py-2'} ${
          current ? 'bg-fill' : ''
        }`}
      >
        <span className="pt-px">
          <LectureStatus done={done} fraction={fraction} />
        </span>
        <span className="sr-only">{status}: </span>
        <span className={`min-w-0 flex-1 text-sm ${current ? 'font-medium text-ink' : 'text-ink'}`}>
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

// Home "Course content" (docs/spec-v2-coaching.md "Course content"). Parts are a real level: overline
// "PART 1", title, quiet "4 projects", and their sections nested under a hairline, with the part's own
// intro lectures as a collapsible "Part introduction" row. A closed section row is only number ·
// title · a quiet ✓ when done; its length (and due date) show on hover/focus. The section she is in
// carries a dot on the hairline and its due date; §04 (skipped by her plan) is dimmed. Lectures render
// only while their section is open. (The Watch sidebar is screens/watch/SectionPanel.tsx.)
import { ChevronDown } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import type { LectureProgress, Section } from '../../../shared/types';
import { useApp } from '../app/context';
import { buildOutline, sectionMeta, type PlanDates } from '../lib/outline';
import { plural } from '../lib/format';
import { useProgress } from '../state/progress';
import { Collapse } from './Collapse';
import { LectureList } from './LectureList';
import { QuietCheck } from './ui';

type Lectures = Record<string, LectureProgress>;

interface Props {
  /** the Continue lecture: its section starts open and carries the "you're here" mark */
  currentId: string | null;
  plan: PlanDates;
}

export function CourseContent({ currentId, plan }: Props) {
  const { course, index } = useApp();
  const lectures = useProgress((s) => s.lectures);
  const currentSection = currentId === null ? null : (index.byId.get(currentId)?.section.id ?? null);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(currentSection ? [currentSection] : []));
  const outline = buildOutline(course);

  const toggle = useCallback(
    (id: string): void =>
      setOpen((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );

  const row = (s: Section, nested: boolean, intro = false) => (
    <SectionRow
      key={s.id}
      section={s}
      nested={nested}
      intro={intro}
      lectures={lectures}
      plan={plan}
      current={s.id === currentSection}
      currentId={s.id === currentSection ? currentId : null}
      open={open.has(s.id)}
      onToggle={toggle}
    />
  );

  return (
    <div>
      {outline.map((node) =>
        node.kind === 'section' ? (
          <div key={node.section.id} className="pt-2">
            {row(node.section, false)}
          </div>
        ) : (
          <section key={node.intro.id} aria-labelledby={`part-${node.number}`} className="pt-10">
            <p className="px-2 text-xs font-semibold uppercase tracking-[0.08em] text-ink-muted">Part {node.number}</p>
            <h3 id={`part-${node.number}`} className="mt-1 px-2 text-lg font-semibold text-ink">
              {node.title}
              {node.projects !== null && <span className="ml-2 whitespace-nowrap text-sm font-normal text-ink-subtle">{plural(node.projects, 'project')}</span>}
            </h3>
            {/* the nested group: a hairline the "you're here" dot sits on */}
            <div className="ml-2 mt-3 border-l border-line pl-3 sm:pl-4">
              {row(node.intro, true, true)}
              {node.sections.map((s) => row(s, true))}
            </div>
          </section>
        ),
      )}
    </div>
  );
}

const SectionRow = memo(function SectionRow({
  section,
  nested,
  intro,
  lectures,
  plan,
  current,
  currentId,
  open,
  onToggle,
}: {
  section: Section;
  /** inside a part's group (the dot then sits on its hairline) */
  nested: boolean;
  intro: boolean;
  lectures: Lectures;
  plan: PlanDates;
  current: boolean;
  currentId: string | null;
  open: boolean;
  onToggle: (id: string) => void;
}) {
  const meta = sectionMeta(section, lectures, plan);
  const panelId = `section-${section.id}`;
  // always visible: the current section's due date, or "Skipped"; the rest only on hover/focus
  const shownMeta = meta.skipped ? 'Skipped' : current ? meta.due : null;
  const hoverMeta = current || meta.skipped ? meta.length : [meta.length, meta.due].filter(Boolean).join(' · ');
  return (
    <div data-section={section.id} data-current={current ? 'true' : undefined} className="relative">
      {current && (
        // Centred on the part's 1 px hairline: −(group padding 12/16 px + 0.5 px + half the dot). A loose
        // section (§01, a fresh learner's first) has no hairline: the dot sits in the gutter instead.
        <span
          aria-hidden="true"
          className={`absolute top-[21px] size-2 rounded-full bg-accent ${nested ? '-left-[16.5px] sm:-left-[20.5px]' : '-left-3'}`}
        />
      )}
      <h4>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => onToggle(section.id)}
          // items-start + 24 px line boxes: number, ✓ and chevron sit on the FIRST line of a title that
          // wraps (phones), level with the "you're here" dot (top 21 px = py-3 + half a line − half the dot).
          className="group flex w-full items-start gap-3 rounded-md px-2 py-3 text-left leading-6 hover:bg-fill"
        >
          <span className={`w-6 shrink-0 text-sm leading-6 tabular-nums ${current ? 'text-accent-ink' : 'text-ink-subtle'}`}>{intro ? '' : section.id}</span>
          <span
            className={`min-w-0 flex-1 text-[15px] leading-6 ${current ? 'font-semibold text-ink' : meta.skipped ? 'text-ink-subtle' : intro ? 'text-ink-muted' : 'font-medium text-ink'}`}
          >
            {intro ? 'Part introduction' : section.title}
            {current && <span className="sr-only"> — you’re here</span>}
            {/* phones: the due date goes under the title instead of squeezing it */}
            {current && meta.due && <span className="block text-sm font-normal text-ink-muted sm:hidden">{meta.due}</span>}
          </span>
          {meta.skipped && <span className="shrink-0 text-xs font-medium leading-6 text-ink-subtle sm:hidden">Skipped</span>}
          {/* ≥ sm: one right-aligned column, so "due …" / "Skipped" line up row to row. Hover/focus adds the
              length (and the due date of other sections) to its left; it is in flow but transparent, and
              right alignment keeps the always-visible part still. */}
          <span className="hidden w-48 shrink-0 text-right text-sm sm:block">
            {hoverMeta && (
              <span className="hidden tabular-nums text-ink-subtle opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100 group-focus-visible:opacity-100 sm:inline">
                {hoverMeta}
                {shownMeta && ' · '}
              </span>
            )}
            {shownMeta && <span className={meta.skipped ? 'text-xs font-medium text-ink-subtle' : 'text-ink-muted'}>{shownMeta}</span>}
          </span>
          <span className="flex h-6 w-4 shrink-0 items-center justify-center">
            <QuietCheck done={meta.done} />
            {meta.done && <span className="sr-only">, done</span>}
          </span>
          <ChevronDown
            className={`hover-reveal mt-1 size-4 shrink-0 text-ink-subtle transition-[transform,opacity] duration-200 ease-out ${
              open ? 'rotate-180 opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'
            }`}
            strokeWidth={1.5}
            aria-hidden="true"
          />
        </button>
      </h4>
      <Collapse open={open} id={panelId}>
        {(entering) => <LectureList section={section} lectures={lectures} currentId={currentId} entering={entering} className="pb-3 pl-7" />}
      </Collapse>
    </div>
  );
});

// Watch sidebar (docs/spec-v2-coaching.md "Watch sidebar"): only ONE section — the one she is in —
// with its due date, ‹ › to step to the previous/next section (still one at a time), and a "Next:"
// line at the bottom. Nothing else from the course competes with the lecture.
// Watch remounts per lecture (`key={lecture.id}`), so the stepped-to section resets on every lecture.
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../../app/context';
import { LectureList } from '../../components/LectureList';
import { IconButton, QuietCheck } from '../../components/ui';
import { sectionMeta, sectionShortName, sectionSteps, sectionTag, type PlanDates } from '../../lib/outline';
import { useProgress } from '../../state/progress';

export function SectionPanel({ currentId, plan }: { currentId: string; plan: PlanDates }) {
  const { course, index } = useApp();
  const lectures = useProgress((s) => s.lectures);
  const current = index.byId.get(currentId)?.section ?? null;
  const [view, setView] = useState<{ id: string | null; dir: 'next' | 'prev' | null }>({ id: current?.id ?? null, dir: null });
  const scroller = useRef<HTMLDivElement>(null);
  const shown = course.sections.find((s) => s.id === view.id) ?? current;

  // Bring the open lecture into view inside the sidebar's own scroller — never scroll the page
  // (scrollIntoView would also move the window and yank the player away). Only when it is hidden.
  useEffect(() => {
    const box = scroller.current;
    const row = box?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!box || !row || box.scrollHeight <= box.clientHeight) return;
    const top = row.offsetTop - box.offsetTop;
    if (top < box.scrollTop || top + row.offsetHeight > box.scrollTop + box.clientHeight) {
      box.scrollTop = Math.max(0, top - box.clientHeight / 3);
    }
  }, []);

  if (shown === null) return null;
  const { prev, next } = sectionSteps(course, shown.id);
  const meta = sectionMeta(shown, lectures, plan);
  const step = (to: string | null, dir: 'next' | 'prev'): void => {
    if (to === null) return;
    setView({ id: to, dir });
    if (scroller.current) scroller.current.scrollTop = 0;
  };

  return (
    <aside
      aria-label="This section"
      data-sidebar
      className="mt-12 overflow-hidden rounded-lg border border-line bg-surface lg:sticky lg:top-20 lg:mt-0 lg:flex lg:max-h-[calc(100vh-6.5rem)] lg:flex-col"
    >
      <div className="flex items-start gap-1 border-b border-line py-3 pl-4 pr-2">
        <div className="min-w-0 flex-1" aria-live="polite">
          <p className="text-xs font-medium uppercase tracking-[0.06em] text-ink-muted">{sectionTag(shown)}</p>
          <h2 className="mt-0.5 flex items-start gap-1.5 text-sm font-semibold text-ink">
            <span className="min-w-0">{shown.title}</span>
            <QuietCheck done={meta.done} className="mt-0.5 size-4" />
          </h2>
          {(meta.due || meta.skipped) && <p className="mt-0.5 text-xs text-ink-muted">{meta.skipped ? 'Skipped in your plan' : meta.due}</p>}
        </div>
        <IconButton label={prev ? `Previous section: ${sectionShortName(prev)}` : 'No previous section'} size="sm" disabled={prev === null} onClick={() => step(prev?.id ?? null, 'prev')}>
          <ChevronLeft className="size-4" strokeWidth={1.5} />
        </IconButton>
        <IconButton label={next ? `Next section: ${sectionShortName(next)}` : 'No next section'} size="sm" disabled={next === null} onClick={() => step(next?.id ?? null, 'next')}>
          <ChevronRight className="size-4" strokeWidth={1.5} />
        </IconButton>
      </div>
      <div ref={scroller} data-scroller className="quiet-scroll relative lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        <div key={shown.id} className={view.dir === 'next' ? 'animate-step-next' : view.dir === 'prev' ? 'animate-step-prev' : ''}>
          <LectureList section={shown} lectures={lectures} currentId={currentId} currentIsPage className="p-2" />
        </div>
      </div>
      {next && (
        <p className="border-t border-line px-4 py-3 text-sm text-ink-muted">
          Next: <span className="text-ink">{sectionShortName(next)}</span>
        </p>
      )}
    </aside>
  );
}

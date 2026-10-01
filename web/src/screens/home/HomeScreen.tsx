// Home `#/`: Continue hero (the one primary action) · plan strip · stats · last 30 days · course content.
import { useMemo } from 'react';
import { useApp } from '../../app/context';
import { CourseContent } from '../../components/CourseContent';
import { Header } from '../../components/Header';
import { nextLecture } from '../../lib/course';
import { formatDuration } from '../../lib/format';
import { useProgress } from '../../state/progress';
import { ContinueHero } from './ContinueHero';
import { PlanStrip } from './PlanStrip';
import { Stats } from './Stats';
import { ThirtyDays } from './ThirtyDays';

export function HomeScreen() {
  const { course, index, profile } = useApp();
  const lectures = useProgress((s) => s.lectures);
  const lastLectureId = useProgress((s) => s.lastLectureId);
  const studiedAnything = useProgress((s) => Object.keys(s.days).length > 0 || s.lastLectureId !== null);
  const nextId = useMemo(() => nextLecture(index, { lectures, lastLectureId }), [index, lectures, lastLectureId]);
  const ref = nextId === null ? undefined : index.byId.get(nextId);

  return (
    <>
      <Header />
      <main className="mx-auto max-w-[1148px] px-4 pb-24 pt-8 md:px-6 md:pt-12">
        <ContinueHero lecture={ref?.lecture ?? null} section={ref?.section ?? null} progress={nextId ? lectures[nextId] : undefined} fresh={!studiedAnything} />
        <div className="mt-12 space-y-12 md:mt-16 md:space-y-16">
          <PlanStrip profileId={profile.id} connected={profile.journeyConnected} />
          <Stats />
          <ThirtyDays />
          <section aria-labelledby="content-title">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line pb-4">
              <h2 id="content-title" className="text-base font-semibold text-ink">
                Course content
              </h2>
              <p className="text-sm tabular-nums text-ink-muted">
                {course.sections.length} sections · {course.totals.lectures} lectures · {formatDuration(course.totals.duration)}
              </p>
            </div>
            <CourseContent variant="page" currentId={nextId} />
          </section>
        </div>
      </main>
    </>
  );
}

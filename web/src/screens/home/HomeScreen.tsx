// Home `#/`, top to bottom (docs/spec-v2-coaching.md, decision 2): Rahul's feedback (unread, big) →
// Continue (the one primary action) → This week → stats + last 30 days → her updates with his replies →
// course content.
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../app/context';
import { CourseContent } from '../../components/CourseContent';
import { Header } from '../../components/Header';
import { nextLecture } from '../../lib/course';
import { unreadFromRahul } from '../../lib/feed';
import { formatDuration } from '../../lib/format';
import { prefersReducedMotion } from '../../lib/motion';
import { useJourney, useJourneyStore } from '../../state/journey';
import { useProgress } from '../../state/progress';
import { ContinueHero } from './ContinueHero';
import { FromRahul } from './FromRahul';
import { Stats } from './Stats';
import { ThirtyDays } from './ThirtyDays';
import { ThisWeek } from './ThisWeek';
import { YourUpdates } from './YourUpdates';

/** The count-up + chart rise play on the first paint of home only, not on every return from Watch.
 *  Read in a pure useState initializer and cleared in an effect, so StrictMode's double render agrees. */
const intro = { pending: true };

export function HomeScreen() {
  const { course, index } = useApp();
  const journey = useJourney();
  const journeyStore = useJourneyStore();
  const lectures = useProgress((s) => s.lectures);
  const lastLectureId = useProgress((s) => s.lastLectureId);
  const studiedAnything = useProgress((s) => Object.keys(s.days).length > 0 || s.lastLectureId !== null);
  const nextId = useMemo(() => nextLecture(index, { lectures, lastLectureId }), [index, lectures, lastLectureId]);
  const ref = nextId === null ? undefined : index.byId.get(nextId);
  const unread = useMemo(() => unreadFromRahul(journey.feed, journey.readIds), [journey.feed, journey.readIds]);
  const [playIntro] = useState(() => intro.pending && !prefersReducedMotion());
  useEffect(() => {
    intro.pending = false;
  }, []);

  return (
    <>
      <Header />
      <main className="mx-auto max-w-[1148px] px-4 pb-24 pt-8 md:px-6 md:pt-12">
        <FromRahul items={unread} onGotIt={(ids) => journeyStore.markRead(ids)} />
        <ContinueHero lecture={ref?.lecture ?? null} section={ref?.section ?? null} progress={nextId ? lectures[nextId] : undefined} fresh={!studiedAnything} />
        <div className="mt-12 space-y-12 md:mt-16 md:space-y-16">
          <ThisWeek status={journey.status} />
          <div className="space-y-12">
            <Stats status={journey.status} intro={playIntro} />
            <ThirtyDays intro={playIntro} />
          </div>
          <YourUpdates feed={journey.feed} readIds={journey.readIds} stale={journey.stale} outbox={journey.outbox} />
          <section aria-labelledby="content-title">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line pb-4">
              <h2 id="content-title" className="text-base font-semibold text-ink">
                Course content
              </h2>
              <p className="text-sm tabular-nums text-ink-muted">
                {course.sections.length} sections · {course.totals.lectures} lectures · {formatDuration(course.totals.duration)}
              </p>
            </div>
            <CourseContent currentId={nextId} plan={journey.status} />
          </section>
        </div>
      </main>
    </>
  );
}

// The stats row + the 30-day chart, v4 (docs/spec-v4-pace-and-coach.md "Chart + daily goal"): ONE read of
// her study days (+ the running timer) and ONE daily-goal moment for both. The moment must be decided once:
// decided per component, the first would remember the date and the second would find it "already played"
// — the Today ✓ would draw in while the today bar sat still. No dailyGoalMinutes → never met, no moment.
import { useState } from 'react';
import type { JourneyStatus } from '../../../../shared/types';
import { useApp } from '../../app/context';
import { todayKey } from '../../lib/dates';
import { goalMomentKey, useGoalMoment } from '../../lib/goal-moment';
import { prefersReducedMotion } from '../../lib/motion';
import { goalMet, studiedOn } from '../../lib/stats';
import { browserStore } from '../../lib/storage';
import { useStudyDays } from '../../state/study';
import { Stats } from './Stats';
import { ThirtyDays } from './ThirtyDays';

export function StudyNumbers({ status, intro }: { status: JourneyStatus | null; intro: boolean }) {
  const { course, profile } = useApp();
  // + the running timer (display only — days are written at sign-off, state/study.ts)
  const days = useStudyDays();
  const today = todayKey();
  const met = goalMet(studiedOn(days, today), status?.dailyGoalMinutes);
  const [store] = useState(browserStore);
  const moment = useGoalMoment(met, today, goalMomentKey(course.id, profile.id), store);
  // reduced motion: the met state shows at once — no held frames waiting to be scrolled into view
  const [still] = useState(prefersReducedMotion);
  const playMoment = moment && !still;
  return (
    <div className="space-y-12">
      <Stats status={status} intro={intro} days={days} today={today} met={met} moment={playMoment} />
      <ThirtyDays status={status} intro={intro} days={days} today={today} moment={playMoment} />
    </div>
  );
}

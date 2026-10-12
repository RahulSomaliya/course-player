// The once-a-day goal moment (docs/spec-v4-pace-and-coach.md "Chart + daily goal", docs/design.md motion
// table): the first time today's study (signed-off + the running timer, state/study.ts useStudyDays) reads
// as goal-met on home, the Today ✓ draws in and the today bar turns accent with one soft rise. Once per
// DATE: the date is remembered in localStorage (`cp:<course>:<profile>:goal-moment`), so a reload or a
// return from Watch shows the met state without replaying it. Usually she crosses the goal on Watch, so
// "first reads as met on home" (decided at mount) is the common case; a crossing while home is open is the
// other. Storage is a convenience: when it throws or is missing the moment still plays (it may replay once).
// No confetti, no toast — the components only draw a ✓ and lift a bar (screens/home/StudyNumbers.tsx).
import { useEffect, useState } from 'react';
import { readString, writeString, type KeyValueStore } from './storage';

export const goalMomentKey = (courseId: string, profile: string): string => `cp:${courseId}:${profile}:goal-moment`;

/** true while this mount shows today's goal moment. Decided on the FIRST render when today is already met
 *  (a later decision would paint the drawn ✓ first, then restart it), else on the render where `met` turns
 *  true. It stays true for the mount — the CSS animations run once per element — and is false on any later
 *  mount the same day. */
export function useGoalMoment(met: boolean, today: string, key: string, store: KeyValueStore | null): boolean {
  const [momentFor, setMomentFor] = useState<string | null>(() => (met && readString(store, key) !== today ? today : null));
  useEffect(() => {
    if (!met || momentFor === today || readString(store, key) === today) return;
    setMomentFor(today);
  }, [met, today, momentFor, key, store]);
  useEffect(() => {
    // remembered at once: a moment she scrolls away from unseen is not replayed (the components hold it
    // paused until it is in view, lib/motion.ts useSeenOnce)
    if (momentFor !== null) writeString(store, key, momentFor);
  }, [momentFor, key, store]);
  return met && momentFor === today;
}

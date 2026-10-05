// App-wide context for the learner: the course, its index, her profile and app-level actions.
import { createContext, useContext } from 'react';
import type { Course, Profile } from '../../../shared/types';
import type { CourseIndex } from '../lib/course';

export interface AppActions {
  /** the header chip → the sign-off card for the running session (none running: a note-only update) */
  openSignOff: () => void;
  /** menu "Note to Rahul…" → the sign-off card as a note-only update (no time; a running timer goes on) */
  openNote: () => void;
  /** Quit → with the timer running, the sign-off card first ("Send & quit") → flush → stop → "Stopped". */
  quit: () => void;
  /** after connecting/disconnecting JS Journey */
  updateProfile: (p: Profile) => void;
}

export interface AppValue extends AppActions {
  course: Course;
  index: CourseIndex;
  profile: Profile;
}

export const AppContext = createContext<AppValue | null>(null);

export function useApp(): AppValue {
  const v = useContext(AppContext);
  if (v === null) throw new Error('useApp outside <AppContext>');
  return v;
}

// App-wide context for a chosen profile: the course, its index, the profile and app-level actions.
import { createContext, useContext } from 'react';
import type { Course, Profile } from '../../../shared/types';
import type { CourseIndex } from '../lib/course';

export interface AppActions {
  /** End session → wrap-up card (journey-connected, ≥ 5 min) → send; otherwise ends quietly. */
  endSession: () => void;
  /** Quit → wrap-up card when due → flush progress → stop the server → "Stopped" page. */
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

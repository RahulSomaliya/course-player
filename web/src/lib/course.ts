// Course lookups: lecture order, neighbours, section progress and the Continue pick.
import type { Course, Lecture, LectureProgress, ProgressState, Section } from '../../../shared/types';

export interface LectureRef {
  lecture: Lecture;
  section: Section;
  /** 0-based position in course order */
  position: number;
}

export interface CourseIndex {
  order: string[];
  byId: Map<string, LectureRef>;
}

export function indexCourse(course: Course): CourseIndex {
  const order: string[] = [];
  const byId = new Map<string, LectureRef>();
  for (const section of course.sections) {
    for (const lecture of section.lectures) {
      byId.set(lecture.id, { lecture, section, position: order.length });
      order.push(lecture.id);
    }
  }
  return { order, byId };
}

/**
 * The Continue hero's lecture: the last lecture you touched while it is unfinished; once it is done,
 * the next not-done lecture after it (so finishing 05/13 offers 05/14, not an optional lecture you
 * skipped weeks ago); else the first not-done lecture; null when everything is done.
 */
export function nextLecture(idx: CourseIndex, progress: Pick<ProgressState, 'lectures' | 'lastLectureId'>): string | null {
  const notDone = (id: string): boolean => !progress.lectures[id]?.done;
  const last = progress.lastLectureId === null ? undefined : idx.byId.get(progress.lastLectureId);
  if (last) {
    if (notDone(last.lecture.id)) return last.lecture.id;
    const after = idx.order.slice(last.position + 1).find(notDone);
    if (after !== undefined) return after;
  }
  return idx.order.find(notDone) ?? null;
}

export function neighbours(idx: CourseIndex, id: string): { prev: string | null; next: string | null } {
  const ref = idx.byId.get(id);
  if (!ref) return { prev: null, next: null };
  return { prev: idx.order[ref.position - 1] ?? null, next: idx.order[ref.position + 1] ?? null };
}

export function sectionProgress(section: Section, lectures: Record<string, LectureProgress>): { done: number; total: number } {
  return { done: section.lectures.filter((l) => lectures[l.id]?.done).length, total: section.lectures.length };
}

export function isSectionDone(section: Section, lectures: Record<string, LectureProgress>): boolean {
  return section.lectures.length > 0 && section.lectures.every((l) => lectures[l.id]?.done);
}

export function sectionLabel(section: Section): string {
  return `Section ${section.id}`;
}

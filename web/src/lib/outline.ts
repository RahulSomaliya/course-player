// Course content structure (docs/spec-v2-coaching.md "Course content", "Watch sidebar").
// A "Part N - Title (K Projects)" folder is scanned as a Section with `part` set; it holds the part's
// own intro lectures. Here a part becomes a real level: its intro is a collapsible "Part introduction"
// row, and every following section until the next part sits inside it.
import type { Course, JourneyStatus, LectureProgress, Section } from '../../../shared/types';
import { isSectionDone } from './course';
import { formatDay, formatDuration } from './format';

export type OutlineNode =
  | { kind: 'section'; section: Section }
  | { kind: 'part'; number: number; title: string; projects: number | null; intro: Section; sections: Section[] };

export function buildOutline(course: Course): OutlineNode[] {
  const out: OutlineNode[] = [];
  let part: Extract<OutlineNode, { kind: 'part' }> | null = null;
  for (const s of course.sections) {
    if (s.part !== null) {
      part = { kind: 'part', number: s.part.number, title: s.title, projects: s.part.projects, intro: s, sections: [] };
      out.push(part);
    } else if (part !== null) {
      part.sections.push(s);
    } else {
      out.push({ kind: 'section', section: s });
    }
  }
  return out;
}

/** The parts of JourneyStatus a section row needs; null = no plan known (not connected, nothing cached). */
export type PlanDates = Pick<JourneyStatus, 'sectionDue' | 'skippedSections'> | null;

export interface SectionMeta {
  done: boolean;
  /** her plan skips it (React: §04) and she has not finished it — dimmed, "Skipped" */
  skipped: boolean;
  /** "due Fri 9 Oct"; null when unknown, skipped or already done */
  due: string | null;
  /** "2h 54m" */
  length: string;
}

export function sectionMeta(section: Section, lectures: Record<string, LectureProgress>, plan: PlanDates): SectionMeta {
  const done = isSectionDone(section, lectures);
  // `?? []` / `?? {}`: a JS Journey deployed before v2 omits both fields (server/journey.ts lets it through).
  // Finished wins: a skipped section she did anyway is done, never "Skipped" with a ✓ (2026-10-01).
  const skipped = !done && (plan?.skippedSections ?? []).includes(section.number);
  const dueKey = plan?.sectionDue?.[String(section.number)];
  return {
    done,
    skipped,
    due: done || skipped || dueKey === undefined ? null : `due ${formatDay(dueKey)}`,
    length: formatDuration(section.duration),
  };
}

/** "Section 07" · "Part 1 · Introduction" */
export function sectionTag(section: Section): string {
  return section.part ? `Part ${section.part.number} · Introduction` : `Section ${section.id}`;
}

export function sectionTitle(section: Section): string {
  return section.title;
}

/** "§08 Practice Project - Eat-'N-Split" · "Part 2 · Intermediate React" */
export function sectionShortName(section: Section): string {
  return section.part ? `Part ${section.part.number} · ${section.title}` : `§${section.id} ${section.title}`;
}

export function sectionSteps(course: Course, sectionId: string): { prev: Section | null; next: Section | null } {
  const i = course.sections.findIndex((s) => s.id === sectionId);
  if (i < 0) return { prev: null, next: null };
  return { prev: course.sections[i - 1] ?? null, next: course.sections[i + 1] ?? null };
}

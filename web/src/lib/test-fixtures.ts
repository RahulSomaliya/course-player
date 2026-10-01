// Tiny course + progress builders for the web unit tests (not a test file itself).
import type { Course, Lecture, LectureProgress, ProgressState, Section } from '../../../shared/types';
import { emptyProgress } from './progress';

type LectureSpec = { title: string; kind?: Lecture['kind']; duration?: number };

export function section(
  number: number,
  title: string,
  lectures: LectureSpec[],
  extra: Partial<Pick<Section, 'optional' | 'part'>> = {},
): Section {
  const id = String(number).padStart(2, '0');
  const built: Lecture[] = lectures.map((l, i) => {
    const n = String(i + 1).padStart(2, '0');
    const kind = l.kind ?? 'video';
    const ext = kind === 'video' ? 'mp4' : kind === 'article' ? 'html' : 'pdf';
    const rel = `${id} ${title}/${n} ${l.title}.${ext}`;
    return {
      id: rel,
      number: i + 1,
      title: l.title,
      kind,
      duration: kind === 'video' ? (l.duration ?? 600) : 0,
      src: `/media/${rel.split('/').map(encodeURIComponent).join('/')}`,
      resources: [],
    };
  });
  return {
    id,
    number,
    title,
    optional: extra.optional ?? false,
    part: extra.part ?? null,
    lectures: built,
    duration: built.reduce((sum, l) => sum + l.duration, 0),
  };
}

export function course(sections: Section[]): Course {
  const lectures = sections.flatMap((s) => s.lectures);
  return {
    id: 'test-course',
    title: 'Test Course',
    subtitle: null,
    sections,
    totals: {
      lectures: lectures.length,
      videos: lectures.filter((l) => l.kind === 'video').length,
      duration: lectures.reduce((sum, l) => sum + l.duration, 0),
    },
  };
}

/** Three sections: 01 (3 videos of 600 s), 02 a Part divider (1 video + 1 article), 03 (2 videos of 1200 s). */
export function sampleCourse(): Course {
  return course([
    section(1, 'Welcome', [{ title: 'Intro' }, { title: 'Setup' }, { title: 'Roadmap' }]),
    section(2, 'Fundamentals', [{ title: 'Part intro', duration: 60 }, { title: 'Resources', kind: 'article' }], {
      part: { number: 1, projects: 4 },
    }),
    section(3, 'Components', [
      { title: 'Props', duration: 1200 },
      { title: 'State', duration: 1200 },
    ]),
  ]);
}

export function progressWith(lectures: Record<string, Partial<LectureProgress>>, extra: Partial<ProgressState> = {}): ProgressState {
  const base = emptyProgress();
  const full: Record<string, LectureProgress> = {};
  for (const [id, lp] of Object.entries(lectures)) full[id] = { pos: 0, done: false, doneAt: null, ...lp };
  return { ...base, ...extra, lectures: full };
}

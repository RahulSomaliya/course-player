import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { scanCourse } from './scan.ts';
import { makeTempDir, memoryLog, mp4, writeTree } from './test-helpers.ts';

const redirect = (url: string) => `<script type="text/javascript">window.location = "${url}";</script>`;

let tmp = '';
let root = '';
let dataDir = '';
let cleanup: () => Promise<void> = async () => {};

beforeEach(async () => {
  ({ dir: tmp, cleanup } = await makeTempDir('scan'));
  root = path.join(tmp, 'Test Course 2024');
  dataDir = path.join(root, '.player', 'data');
  await mkdir(dataDir, { recursive: true });
  await writeTree(root, {
    '01 Welcome/01 Intro.mp4': mp4({ duration: 60_000 }),
    '01 Welcome/02 Setup.mp4': mp4({ duration: 90_000, moovAtEnd: true }),
    '01 Welcome/02.2 Slides.pdf': '%PDF-1.4',
    '01 Welcome/02.1 CodeSandbox.html': redirect('https://codesandbox.io/s/abc'),
    '01 Welcome/03 Read Me.html': '<p>Read me first</p>',
    '01 Welcome/03.1 Notes.html': '<p>plain page</p>',
    '01 Welcome/05.1 Orphan Link.html': redirect('https://example.com/orphan'),
    '01 Welcome/._01 Intro.mp4': 'AppleDouble junk',
    '01 Welcome/.DS_Store': 'junk',
    '01 Welcome/notes.txt': 'not a course file',
    '02 Part 1 - Basics (2 Projects)/01 Intro to Part 1.mp4': mp4({ duration: 30_000 }),
    '03 Extras (Optional)/00.1 Early Link.html': redirect('https://example.com/early'),
    '03 Extras (Optional)/01 Bonus.mp4': mp4({ version: 1, timescale: 600, duration: 600 * 45 }),
    '03 Extras (Optional)/02 Cheatsheet.pdf': '%PDF-1.4',
    '03 Zz Duplicate Number/01 Ignored.mp4': mp4(),
    '04 Empty Section/notes.txt': 'no lectures here',
    '._03 Extras (Optional)': 'AppleDouble junk',
    'Random Folder/01 Not A Section.mp4': mp4(),
    'README.txt': 'hello',
    '.player/web/index.html': '<!doctype html>',
  });
});
afterEach(() => cleanup());

describe('scanCourse', () => {
  it('builds sections, lectures, resources and totals from the folder tree', async () => {
    const { log } = memoryLog();
    const { course } = await scanCourse({ root, dataDir, title: null, subtitle: null, log });

    expect(course.id).toBe('test-course-2024');
    expect(course.title).toBe('Test Course 2024');
    expect(course.subtitle).toBeNull();
    expect(course.sections.map((s) => s.id)).toEqual(['01', '02', '03']);

    const [welcome, part, extras] = course.sections;
    expect(welcome?.lectures.map((l) => [l.number, l.title, l.kind])).toEqual([
      [1, 'Intro', 'video'],
      [2, 'Setup', 'video'],
      [3, 'Read Me', 'article'],
    ]);
    const setup = welcome?.lectures[1];
    expect(setup?.id).toBe('01 Welcome/02 Setup.mp4');
    expect(setup?.src).toBe('/media/01%20Welcome/02%20Setup.mp4');
    expect(setup?.duration).toBeCloseTo(90);
    expect(setup?.resources).toEqual([
      { title: 'CodeSandbox', kind: 'link', href: 'https://codesandbox.io/s/abc' },
      { title: 'Slides', kind: 'pdf', href: '/media/01%20Welcome/02.2%20Slides.pdf' },
    ]);
    // plain html resource -> served from /media; orphan 05.1 attaches to the nearest earlier lecture (03)
    expect(welcome?.lectures[2]?.resources).toEqual([
      { title: 'Notes', kind: 'link', href: '/media/01%20Welcome/03.1%20Notes.html' },
      { title: 'Orphan Link', kind: 'link', href: 'https://example.com/orphan' },
    ]);
    expect(welcome?.lectures[2]?.duration).toBe(0);
    expect(welcome?.duration).toBeCloseTo(150);

    expect(part).toMatchObject({ number: 2, title: 'Basics', optional: false, part: { number: 1, projects: 2 } });
    expect(extras).toMatchObject({ title: 'Extras', optional: true, part: null });
    // 00.1 has no earlier lecture -> it attaches to the first one rather than being dropped
    expect(extras?.lectures[0]?.resources.map((r) => r.title)).toEqual(['Early Link']);
    expect(extras?.lectures[0]?.duration).toBeCloseTo(45);
    expect(extras?.lectures[1]).toMatchObject({ kind: 'pdf', duration: 0 });

    expect(course.totals.lectures).toBe(6);
    expect(course.totals.videos).toBe(4);
    expect(course.totals.duration).toBeCloseTo(225);
  });

  it('uses the configured title/subtitle when given', async () => {
    const { log } = memoryLog();
    const { course } = await scanCourse({ root, dataDir, title: 'The Course', subtitle: 'Someone · 2024', log });
    expect(course.title).toBe('The Course');
    expect(course.subtitle).toBe('Someone · 2024');
  });

  it('logs skipped duplicates/empty sections and a summary line', async () => {
    const { log, lines } = memoryLog();
    await scanCourse({ root, dataDir, title: null, subtitle: null, log });
    expect(lines).toContain('[scan] skipped "03 Zz Duplicate Number": section 03 already exists');
    expect(lines).toContain('[scan] skipped "04 Empty Section": no lectures');
    expect(lines).toContain('[scan] 3 sections, 6 lectures, 4 videos, 0.1 h (4 cache misses)');
  });

  it('caches durations in <data>/durations.json and reuses them on the next scan', async () => {
    const { log } = memoryLog();
    expect((await scanCourse({ root, dataDir, title: null, subtitle: null, log })).misses).toBe(4);
    const cache = JSON.parse(await readFile(path.join(dataDir, 'durations.json'), 'utf8')) as Record<string, { duration: number }>;
    expect(cache['01 Welcome/01 Intro.mp4']?.duration).toBeCloseTo(60);
    const again = await scanCourse({ root, dataDir, title: null, subtitle: null, log });
    expect(again.misses).toBe(0);
    expect(again.course.totals.duration).toBeCloseTo(225);
  });
});

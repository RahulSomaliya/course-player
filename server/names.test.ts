import { describe, expect, it } from 'vitest';
import { mediaHref, parseFileName, parseRedirectUrl, parseSectionName, slugify } from './names.ts';

describe('parseSectionName', () => {
  it('parses a plain section', () => {
    expect(parseSectionName('05 Working With Components, Props, and JSX')).toEqual({
      id: '05',
      number: 5,
      title: 'Working With Components, Props, and JSX',
      optional: false,
      part: null,
    });
  });

  it('strips (Optional) and flags it', () => {
    expect(parseSectionName("08 Practice Project - Eat-'N-Split (Optional)")).toMatchObject({
      id: '08',
      title: "Practice Project - Eat-'N-Split",
      optional: true,
      part: null,
    });
  });

  it('parses Part dividers with a project count (plural and singular)', () => {
    expect(parseSectionName('02 Part 1 - React Fundamentals (4 Projects)')).toMatchObject({
      id: '02',
      title: 'React Fundamentals',
      part: { number: 1, projects: 4 },
    });
    expect(parseSectionName('09 Part 2 - Intermediate React (1 Project)')).toMatchObject({
      title: 'Intermediate React',
      part: { number: 2, projects: 1 },
    });
  });

  it('parses a Part divider without a project count', () => {
    expect(parseSectionName('15 Part 3 - Advanced React + Redux')).toMatchObject({
      title: 'Advanced React + Redux',
      part: { number: 3, projects: null },
    });
  });

  it('rejects names that are not sections', () => {
    expect(parseSectionName('.player')).toBeNull();
    expect(parseSectionName('5 Too Short')).toBeNull();
    expect(parseSectionName('05Missing space')).toBeNull();
    expect(parseSectionName('🟢 Open React Course.command')).toBeNull();
  });
});

describe('parseFileName', () => {
  it('parses lectures by extension', () => {
    expect(parseFileName('13 Challenge #1 - Profile Card (v1).mp4')).toEqual({
      role: 'lecture',
      number: 13,
      title: 'Challenge #1 - Profile Card (v1)',
      kind: 'video',
    });
    expect(parseFileName('04 Read Before You Start!.html')).toMatchObject({ role: 'lecture', kind: 'article' });
    expect(parseFileName('07 Cheat Sheet.pdf')).toMatchObject({ role: 'lecture', kind: 'pdf' });
  });

  it('parses NN.M files as resources of lecture NN', () => {
    expect(parseFileName('04.2 Theory Slides.pdf')).toEqual({
      role: 'resource',
      lecture: 4,
      sub: 2,
      title: 'Theory Slides',
      ext: 'pdf',
    });
    expect(parseFileName('13.1 CodeSandbox - Final v1.html')).toMatchObject({ role: 'resource', lecture: 13, sub: 1 });
  });

  it('ignores anything else', () => {
    expect(parseFileName('._04 Read Before You Start!.html')).toBeNull();
    expect(parseFileName('13 Notes.txt')).toBeNull();
    expect(parseFileName('Notes.mp4')).toBeNull();
    expect(parseFileName('13.mp4')).toBeNull();
  });
});

describe('parseRedirectUrl', () => {
  it('extracts the URL of a window.location redirect page', () => {
    expect(
      parseRedirectUrl('<script type="text/javascript">window.location = "https://codesandbox.io/s/x-52879f";</script>'),
    ).toBe('https://codesandbox.io/s/x-52879f');
    expect(parseRedirectUrl("<script>window.location.href='http://example.com/a'</script>")).toBe('http://example.com/a');
  });

  it('returns null for ordinary pages and non-http targets', () => {
    expect(parseRedirectUrl('<p>Here are some resources</p>')).toBeNull();
    expect(parseRedirectUrl('<script>window.location = "javascript:alert(1)"</script>')).toBeNull();
  });
});

describe('slugify / mediaHref', () => {
  it('slugs the course folder name', () => {
    expect(slugify('React 2023')).toBe('react-2023');
    expect(slugify('  Café: Node.js — Advanced!  ')).toBe('cafe-node-js-advanced');
  });

  it('encodes each path segment, keeping the slashes', () => {
    expect(mediaHref('05 Props & JSX/13 Challenge #1 (v1).mp4')).toBe(
      '/media/05%20Props%20%26%20JSX/13%20Challenge%20%231%20(v1).mp4',
    );
  });
});

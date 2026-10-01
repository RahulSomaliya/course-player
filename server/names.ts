// Name parsing for course folders and files (docs/spec.md §2 "Scanning"). Pure functions.
import type { LectureKind } from '../shared/types.ts';

export interface ParsedSection {
  /** "05" — the zero-padded folder prefix */
  id: string;
  number: number;
  /** without the number prefix, " (Optional)" and, for Part dividers, "Part N - " / " (K Projects)" */
  title: string;
  optional: boolean;
  part: { number: number; projects: number | null } | null;
}

export type ParsedFile =
  | { role: 'lecture'; number: number; title: string; kind: LectureKind }
  | { role: 'resource'; lecture: number; sub: number; title: string; ext: FileExt };

export type FileExt = 'mp4' | 'html' | 'pdf';

const SECTION_RE = /^(\d{2}) (.+)$/;
const OPTIONAL_SUFFIX = ' (Optional)';
const PART_RE = /^Part (\d+) - (.+?)(?: \((\d+) Projects?\))?$/;
const FILE_RE = /^(\d{2})(?:\.(\d+))? (.+)\.(mp4|html|pdf)$/;
// Udemy-style link resources are a one-line page: <script>window.location = "https://…";</script>
const REDIRECT_RE = /window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/;

const KIND_BY_EXT: Record<FileExt, LectureKind> = { mp4: 'video', html: 'article', pdf: 'pdf' };

export function parseSectionName(name: string): ParsedSection | null {
  const m = SECTION_RE.exec(name);
  if (!m) return null;
  const id = m[1] as string;
  let title = m[2] as string;
  const optional = title.endsWith(OPTIONAL_SUFFIX);
  if (optional) title = title.slice(0, -OPTIONAL_SUFFIX.length);
  let part: ParsedSection['part'] = null;
  const p = PART_RE.exec(title);
  if (p) {
    part = { number: Number(p[1]), projects: p[3] === undefined ? null : Number(p[3]) };
    // The web app renders "PART 1 · React Fundamentals · 4 projects" from part + title.
    title = p[2] as string;
  }
  return { id, number: Number(id), title, optional, part };
}

export function parseFileName(name: string): ParsedFile | null {
  const m = FILE_RE.exec(name);
  if (!m) return null;
  const number = Number(m[1]);
  const title = m[3] as string;
  const ext = m[4] as FileExt;
  if (m[2] !== undefined) return { role: 'resource', lecture: number, sub: Number(m[2]), title, ext };
  return { role: 'lecture', number, title, kind: KIND_BY_EXT[ext] };
}

/** The external URL of a redirect page, or null. Only http(s) targets count: anything else (e.g. a
 *  `javascript:` URL) would become a clickable href in the app. */
export function parseRedirectUrl(html: string): string | null {
  const m = REDIRECT_RE.exec(html);
  if (!m) return null;
  const url = (m[1] as string).trim();
  return /^https?:\/\//i.test(url) ? url : null;
}

/** "React 2023" -> "react-2023". Namespaces the web app's storage keys and the JS Journey course id. */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** "/media/<encodeURIComponent per segment>" for a root-relative path that uses "/" separators. */
export function mediaHref(relPath: string): string {
  return '/media/' + relPath.split('/').map(encodeURIComponent).join('/');
}

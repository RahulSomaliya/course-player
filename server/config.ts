// <data>/config.json: course title/subtitle + profiles (+ a profile's JS Journey student link), and an
// optional `courseId` (v3: second in line after .player/course.json — server/course-id.ts).
// Seeded by scripts/deploy.sh from scripts/seed-config.json only when absent; afterwards only the
// server writes it (atomically). The student link contains the token: it never leaves this module
// except through journeyLink() for server-side calls — the browser only sees `journeyConnected`.
import path from 'node:path';
import type { Profile } from '../shared/types.ts';
import { isCourseId } from './course-id.ts';
import { KeyedMutex, readJsonFile, writeFileAtomic } from './store.ts';

/** Profile ids name files (progress-<id>.json), so they stay filename- and URL-safe. */
export const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

interface ProfileEntry {
  id: string;
  name: string;
  journeyLink?: string;
  [key: string]: unknown;
}

interface ConfigFile {
  title?: string;
  subtitle?: string | null;
  courseId?: string;
  profiles: ProfileEntry[];
  [key: string]: unknown;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function parseConfig(raw: unknown, file: string): ConfigFile {
  const fail = (why: string): never => {
    throw new Error(`${file}: ${why}`);
  };
  if (!isRecord(raw)) return fail('must be a JSON object');
  if (raw.title !== undefined && typeof raw.title !== 'string') fail('title must be a string');
  if (raw.subtitle !== undefined && raw.subtitle !== null && typeof raw.subtitle !== 'string') fail('subtitle must be a string or null');
  if (raw.courseId !== undefined && !isCourseId(raw.courseId)) fail('courseId must be a course id like "react-2023"');
  const profiles = raw.profiles ?? [];
  if (!Array.isArray(profiles)) return fail('profiles must be an array');
  const seen = new Set<string>();
  profiles.forEach((p: unknown, i) => {
    if (!isRecord(p)) return fail(`profiles[${i}] must be an object`);
    if (typeof p.id !== 'string' || !PROFILE_ID_RE.test(p.id)) fail(`profiles[${i}].id must match ${PROFILE_ID_RE}`);
    if (typeof p.name !== 'string' || p.name.trim() === '') fail(`profiles[${i}].name must be a non-empty string`);
    if (p.journeyLink !== undefined && typeof p.journeyLink !== 'string') fail(`profiles[${i}].journeyLink must be a string`);
    if (seen.has(p.id as string)) fail(`duplicate profile id "${String(p.id)}"`);
    seen.add(p.id as string);
  });
  return { ...raw, profiles: profiles as ProfileEntry[] }; // every entry validated just above
}

export class ConfigStore {
  /** serializes read-modify-write of config.json (two profiles connecting at once) */
  private readonly lock = new KeyedMutex();

  private constructor(
    private readonly file: string,
    private data: ConfigFile,
    /** false when config.json was absent (folder-name title, no profiles) */
    readonly exists: boolean,
  ) {}

  /** Throws (with the file path) when config.json exists but is invalid: main exits loudly then. */
  static async load(dataDir: string): Promise<ConfigStore> {
    const file = path.join(dataDir, 'config.json');
    const raw = await readJsonFile(file);
    if (raw === undefined) return new ConfigStore(file, { profiles: [] }, false);
    return new ConfigStore(file, parseConfig(raw, file), true);
  }

  get title(): string | null {
    return this.data.title ?? null;
  }

  get subtitle(): string | null {
    return this.data.subtitle ?? null;
  }

  /** null = not set (every v1/v2 config.json); resolution order in course-id.ts */
  get courseId(): string | null {
    return this.data.courseId ?? null;
  }

  has(profileId: string): boolean {
    return this.data.profiles.some((p) => p.id === profileId);
  }

  profiles(): Profile[] {
    return this.data.profiles.map(toProfile);
  }

  profile(profileId: string): Profile | null {
    const entry = this.data.profiles.find((p) => p.id === profileId);
    return entry ? toProfile(entry) : null;
  }

  /** Server-side only — contains the student token. */
  journeyLink(profileId: string): string | null {
    return this.data.profiles.find((p) => p.id === profileId)?.journeyLink ?? null;
  }

  connectedProfileIds(): string[] {
    return this.data.profiles.filter((p) => p.journeyLink !== undefined).map((p) => p.id);
  }

  setJourneyLink(profileId: string, link: string | null): Promise<Profile> {
    return this.lock.run('config', async () => {
      const profiles = this.data.profiles.map((p) => {
        if (p.id !== profileId) return p;
        const { journeyLink: _old, ...rest } = p;
        return link === null ? rest : { ...rest, journeyLink: link };
      });
      const next: ConfigFile = { ...this.data, profiles };
      await writeFileAtomic(this.file, JSON.stringify(next, null, 2) + '\n');
      this.data = next;
      const updated = this.profile(profileId);
      if (!updated) throw new Error(`setJourneyLink: unknown profile "${profileId}"`);
      return updated;
    });
  }
}

function toProfile(p: ProfileEntry): Profile {
  return { id: p.id, name: p.name, journeyConnected: p.journeyLink !== undefined };
}

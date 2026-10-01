// Durable files in the data dir (<course>/.player/data on the SSD): atomic JSON writes and the
// per-profile progress copy with last-writer-wins on `updatedAt`.
import { open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { LectureProgress, Prefs, ProgressState } from '../shared/types.ts';
import { errorMessage, type Log } from './log.ts';

/** Runs async tasks one at a time per key (FIFO); different keys run in parallel. */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(() => task());
    // The chain only needs to know when the task settled; the caller still receives `result`
    // with its rejection, so nothing is swallowed here.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

const fileLocks = new KeyedMutex();

/** exFAT-safe write: <file>.tmp, fsync, rename over the target. A crash or yanked SSD leaves either
 *  the old or the new file, never a torn one. Writes to the same path are serialized because they
 *  share the one .tmp name. */
export function writeFileAtomic(file: string, data: string): Promise<void> {
  const abs = path.resolve(file);
  return fileLocks.run(abs, async () => {
    const tmp = `${abs}.tmp`;
    const fh = await open(tmp, 'w');
    try {
      await fh.writeFile(data, 'utf8');
      await fh.datasync();
    } finally {
      await fh.close();
    }
    await rename(tmp, abs);
  });
}

export class JsonFileError extends Error {}

/** Parsed JSON, or undefined when the file does not exist. Invalid JSON throws a JsonFileError
 *  naming the file. */
export async function readJsonFile(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new JsonFileError(`${file} is not valid JSON: ${errorMessage(err)}`);
  }
}

// ---- progress validation + LWW ------------------------------------------------------

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

const isCount = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;

function validLectureProgress(x: unknown): x is LectureProgress {
  return isRecord(x) && isCount(x.pos) && typeof x.done === 'boolean' && (x.doneAt === null || isCount(x.doneAt));
}

function validPrefs(x: unknown): x is Prefs {
  return (
    isRecord(x) &&
    isCount(x.rate) &&
    isCount(x.volume) &&
    typeof x.muted === 'boolean' &&
    typeof x.autoplay === 'boolean' &&
    (x.theme === null || x.theme === 'light' || x.theme === 'dark')
  );
}

/** null when `x` is a ProgressState, else a short reason naming the first bad field. */
export function validateProgress(x: unknown): string | null {
  if (!isRecord(x)) return 'body must be a ProgressState object';
  if (x.v !== 1) return 'v must be 1';
  if (!isCount(x.updatedAt)) return 'updatedAt must be epoch ms';
  if (!isRecord(x.lectures)) return 'lectures must be an object';
  for (const [id, lp] of Object.entries(x.lectures)) {
    if (!validLectureProgress(lp)) return `lectures[${JSON.stringify(id)}] must be {pos, done, doneAt}`;
  }
  if (!isRecord(x.days)) return 'days must be an object';
  for (const [day, secs] of Object.entries(x.days)) {
    if (!isCount(secs)) return `days[${JSON.stringify(day)}] must be seconds`;
  }
  if (!(x.lastLectureId === null || typeof x.lastLectureId === 'string')) return 'lastLectureId must be a string or null';
  if (!validPrefs(x.prefs)) return 'prefs must be {rate, volume, muted, autoplay, theme}';
  return null;
}

export function isProgressState(x: unknown): x is ProgressState {
  return validateProgress(x) === null;
}

/** Last writer wins on `updatedAt`; a tie keeps the stored copy (no rewrite). */
export function pickNewer(stored: ProgressState | null, incoming: ProgressState): { winner: ProgressState; changed: boolean } {
  if (stored === null || incoming.updatedAt > stored.updatedAt) return { winner: incoming, changed: true };
  return { winner: stored, changed: false };
}

/** <data>/progress-<profile>.json — the SSD copy that lets progress follow the drive to any Mac.
 *  The browser's localStorage copy is primary; both sides merge with pickNewer. */
export class ProgressStore {
  private readonly locks = new KeyedMutex();

  constructor(
    private readonly dataDir: string,
    private readonly log: Log,
  ) {}

  get(profile: string): Promise<ProgressState | null> {
    return this.locks.run(profile, () => this.read(profile));
  }

  put(profile: string, incoming: ProgressState): Promise<ProgressState> {
    return this.locks.run(profile, async () => {
      const { winner, changed } = pickNewer(await this.read(profile), incoming);
      if (changed) await writeFileAtomic(this.file(profile), JSON.stringify(winner));
      return winner;
    });
  }

  private file(profile: string): string {
    return path.join(this.dataDir, `progress-${profile}.json`);
  }

  private async read(profile: string): Promise<ProgressState | null> {
    const file = this.file(profile);
    let raw: unknown;
    try {
      raw = await readJsonFile(file);
    } catch (err) {
      if (!(err instanceof JsonFileError)) throw err;
      return this.moveAside(file, 'not valid JSON');
    }
    if (raw === undefined) return null;
    const problem = validateProgress(raw);
    if (problem !== null) return this.moveAside(file, problem);
    return raw as ProgressState; // validated by validateProgress just above
  }

  /** A corrupt copy would otherwise make every GET/PUT for this profile fail; keep it for
   *  inspection and let the browser's copy win on the next PUT. */
  private async moveAside(file: string, reason: string): Promise<null> {
    const name = path.basename(file);
    await rename(file, `${file}.corrupt`);
    this.log(`[store] ${name} is unreadable (${reason}) — moved aside to ${name}.corrupt`);
    return null;
  }
}

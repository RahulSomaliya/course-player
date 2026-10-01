// Shared helpers for the server vitest suites (not a test file itself).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { JourneySession, ProgressState } from '../shared/types.ts';

// ---- temp dirs ----------------------------------------------------------------

export async function makeTempDir(label: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), `cp-server-${label}-`));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Writes `files` (relative path -> contents) under `root`, creating folders. */
export async function writeTree(root: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, contents);
  }
}

// ---- synthetic mp4 boxes -----------------------------------------------------------

export function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

/** Box with size field 1 + a 64-bit "largesize" (how >4 GiB mdat boxes are written). */
export function box64(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  const head = Buffer.alloc(16);
  head.writeUInt32BE(1, 0);
  head.write(type, 4, 'latin1');
  head.writeBigUInt64BE(BigInt(16 + body.length), 8);
  return Buffer.concat([head, body]);
}

/** mvhd payload: version/flags, times, timescale, duration, then the fixed tail (rate, volume, matrix…). */
export function mvhd(version: 0 | 1, timescale: number, duration: number): Buffer {
  const tail = Buffer.alloc(80);
  if (version === 0) {
    const head = Buffer.alloc(20);
    head.writeUInt8(0, 0);
    head.writeUInt32BE(timescale, 12);
    head.writeUInt32BE(duration, 16);
    return box('mvhd', head, tail);
  }
  const head = Buffer.alloc(32);
  head.writeUInt8(1, 0);
  head.writeUInt32BE(timescale, 20);
  head.writeBigUInt64BE(BigInt(duration), 24);
  return box('mvhd', head, tail);
}

export interface Mp4Options {
  version?: 0 | 1;
  timescale?: number;
  duration?: number;
  moovAtEnd?: boolean;
  mdat64?: boolean;
  mdatBytes?: number;
}

export function mp4(opts: Mp4Options = {}): Buffer {
  const { version = 0, timescale = 1000, duration = 61_500, moovAtEnd = false, mdat64 = false, mdatBytes = 256 } = opts;
  const ftyp = box('ftyp', Buffer.from('isom\0\0\x02\0isomiso2avc1mp41', 'latin1'));
  const trak = box('trak', box('tkhd', Buffer.alloc(84)));
  const moov = box('moov', mvhd(version, timescale, duration), trak);
  const media = Buffer.alloc(mdatBytes, 0xab);
  const mdat = mdat64 ? box64('mdat', media) : box('mdat', media);
  return moovAtEnd ? Buffer.concat([ftyp, mdat, moov]) : Buffer.concat([ftyp, moov, mdat]);
}

// ---- HTTP -------------------------------------------------------------------------------

export interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  text: string;
  json: () => unknown;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Host header; defaults to the one origin the server accepts, localhost:<port> */
  host?: string;
}

/** Talks to 127.0.0.1 directly (the server binds IPv4 only) with an explicit Host header. */
export function request(port: number, method: string, urlPath: string, opts: RequestOptions = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: urlPath,
        headers: { host: opts.host ?? `localhost:${port}`, ...opts.headers },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          const text = body.toString('utf8');
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text, json: () => JSON.parse(text) as unknown });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** JSON body + the CSRF header every non-GET /api call needs. */
export function jsonBody(value: unknown): RequestOptions {
  return {
    headers: { 'content-type': 'application/json', 'x-course-player': '1' },
    body: JSON.stringify(value),
  };
}

/** Collects log lines so tests stay quiet and can assert on them. */
export function memoryLog(): { log: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (line) => lines.push(line), lines };
}

// ---- fixtures ---------------------------------------------------------------------------

export function progress(updatedAt: number, extra: Partial<ProgressState> = {}): ProgressState {
  return {
    v: 1,
    updatedAt,
    lectures: { '01 Intro/01 Hello.mp4': { pos: 12, done: false, doneAt: null } },
    days: { '2026-10-01': 600 },
    lastLectureId: '01 Intro/01 Hello.mp4',
    prefs: { rate: 1.25, volume: 0.8, muted: false, autoplay: true, theme: null },
    ...extra,
  };
}

export function session(id: string, extra: Partial<JourneySession> = {}): JourneySession {
  return {
    id,
    course: 'react-2023',
    startedAt: '2026-10-05T09:00:00.000Z',
    endedAt: '2026-10-05T10:12:00.000Z',
    studyDate: '2026-10-05',
    minutes: 72,
    sectionNumber: 3,
    lecturesCompleted: [{ section: 3, lecture: 4, title: 'Hello React' }],
    finishedSections: [],
    mood: '🙂',
    note: null,
    ...extra,
  };
}

// ---- stub JS Journey ------------------------------------------------------------------------

export interface SeenRequest {
  method: string;
  url: string;
  auth: string | undefined;
  body: string;
}

export interface StubJourney {
  origin: string;
  seen: SeenRequest[];
  /** how the stub answers from now on */
  setReply: (fn: (req: SeenRequest) => { status: number; body?: unknown }) => void;
  close: () => Promise<void>;
}

export async function startStubJourney(): Promise<StubJourney> {
  const seen: SeenRequest[] = [];
  let reply: (req: SeenRequest) => { status: number; body?: unknown } = () => ({ status: 200, body: {} });
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const s: SeenRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        auth: req.headers.authorization,
        body: Buffer.concat(chunks).toString(),
      };
      seen.push(s);
      const r = reply(s);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(r.body === undefined ? '' : JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    setReply: (fn) => {
      reply = fn;
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

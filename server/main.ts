// Entry point — bundled by scripts/build-sea.sh into ONE CommonJS file for the Node single-executable
// app. Keep it SEA-safe: no import.meta.url, no dynamic import(), no native addons; derive every path
// from CLI args / process.execPath (see cli.ts). No top-level await either (CJS output).
import { spawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { isSea } from 'node:sea';
import { createCourseServer } from './app.ts';
import { parseArgs, USAGE } from './cli.ts';
import { errorMessage, stdoutLog as log } from './log.ts';
import { VERSION } from './version.ts';

function openBrowser(url: string): void {
  const child = spawn('open', [url], { stdio: 'ignore', detached: true });
  child.on('error', (err) => log(`[server] could not open the browser (${err.message}) — open ${url} yourself`));
  child.unref();
}

/** true when the program on `port` answers /api/ping as course-player. */
function isCoursePlayer(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/ping', headers: { host: `localhost:${port}` }, timeout: 1000, agent: false },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => {
          try {
            resolve((JSON.parse(body) as { app?: unknown }).app === 'course-player');
          } catch {
            resolve(false); // something else owns the port
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('ping timed out')));
    req.on('error', () => resolve(false)); // no answer = not us
  });
}

/** Resolves with an exit code, or null while the server keeps running. */
async function main(): Promise<number | null> {
  const parsed = parseArgs(process.argv.slice(2), { isSea: isSea(), execPath: process.execPath, cwd: process.cwd() });
  if (parsed.kind === 'version') {
    process.stdout.write(VERSION + '\n');
    return 0;
  }
  if (parsed.kind === 'help') {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  if (parsed.kind === 'error') {
    process.stderr.write(`${parsed.message}\n\n${USAGE}\n`);
    return 2;
  }

  const { root, port, open, dataDir, webDir } = parsed.options;
  const rootStat = await stat(root).catch((err: unknown) => {
    process.stderr.write(`Course folder not found: ${root} (${errorMessage(err)})\n`);
    return null;
  });
  if (rootStat === null) return 1;
  if (!rootStat.isDirectory()) {
    process.stderr.write(`Not a folder: ${root}\n`);
    return 1;
  }

  const app = await createCourseServer({ root, dataDir, webDir, version: VERSION, log, exit: (code) => process.exit(code) });
  let bound: number;
  try {
    bound = await app.listen(port);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    if (await isCoursePlayer(port)) {
      log(`Course Player is already running at http://localhost:${port}`);
      if (open) openBrowser(`http://localhost:${port}/`);
      return 0;
    }
    process.stderr.write(`Port ${port} is in use by another program. Quit that program, or start with --port <another port>.\n`);
    return 1;
  }

  const url = `http://localhost:${bound}/`;
  log(`[server] Course Player ${VERSION} at ${url}`);
  log(`[server] course: ${root}`);
  log(`[server] id:     ${app.courseId.id} (from ${app.courseId.from === 'folder' ? 'the folder name — a guess' : app.courseId.from})`);
  log(`[server] data:   ${dataDir}`);
  const webBuilt = await access(path.join(webDir, 'index.html')).then(
    () => true,
    () => false,
  );
  log(`[server] web:    ${webDir}${webBuilt ? '' : ' (not built — / shows a note)'}`);
  void app.journey.start(); // never rejects: start-up delivery failures are logged inside
  if (open) openBrowser(url);

  // Closing the Terminal window sends SIGHUP; Ctrl-C sends SIGINT. Both get the same bounded
  // outbox flush as the Quit button. A second signal exits at once.
  let signalled = false;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      if (signalled) process.exit(130);
      signalled = true;
      void app.shutdown(signal);
    });
  }
  return null;
}

main().then(
  (code) => {
    if (code !== null) process.exit(code);
  },
  (err: unknown) => {
    process.stderr.write(`[server] failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  },
);

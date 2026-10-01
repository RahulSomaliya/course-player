// GET /* : the built web app (dist/web, deployed to .player/web). index.html is never cached (it
// names the current hashed bundles); /assets/* are content-hashed, so cached forever. Unknown paths
// get index.html (the app uses hash routes, but a stray deep link should still land in the app).
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { sendText } from './http.ts';
import { resolveUnderRoot } from './media.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const IMMUTABLE = 'public, max-age=31536000, immutable';

async function sendFile(req: IncomingMessage, res: ServerResponse, file: string, cacheControl: string): Promise<void> {
  const body = await readFile(file);
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': cacheControl,
    'x-content-type-options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/** `rawPath` is the undecoded request path (the same traversal guard as /media applies). */
export async function serveStatic(req: IncomingMessage, res: ServerResponse, webDir: string, rawPath: string): Promise<void> {
  const rel = rawPath.replace(/^\/+/, '');
  const file = rel === '' ? null : await resolveUnderRoot(webDir, rel);
  if (file !== null) {
    await sendFile(req, res, file, rawPath.startsWith('/assets/') ? IMMUTABLE : 'no-cache');
    return;
  }
  // A missing hashed bundle must not be answered with HTML (the browser would try to run it).
  if (rawPath.startsWith('/assets/')) {
    sendText(res, 404, 'Not found');
    return;
  }
  const index = await resolveUnderRoot(webDir, 'index.html');
  if (index === null) {
    sendText(
      res,
      200,
      `Course Player is running, but the web app is not built (no index.html in ${webDir}).\n` +
        'Run "npm run build" (or use the Vite dev server: npm run dev:web).\n',
    );
    return;
  }
  await sendFile(req, res, index, 'no-cache');
}

// Small response/request helpers shared by the route handlers.
import type { IncomingMessage, ServerResponse } from 'node:http';

/** A failure with the status code + short message the client should see. Internals stay in the log. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(text);
}

export function sendText(res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

export function sendEmpty(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, headers);
  res.end();
}

/** Reads and parses a JSON body; 413 above `limit` bytes, 400 for invalid JSON. */
export async function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    // Keep draining past the limit: answering mid-upload makes the client see EPIPE/ECONNRESET
    // instead of the 413 (loopback only, so reading the rest costs nothing that matters).
    if (size <= limit) chunks.push(chunk);
  }
  if (size > limit) throw new HttpError(413, `Body is larger than ${limit} bytes`);
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'Body is not valid JSON');
  }
}

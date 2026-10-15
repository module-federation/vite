import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'vite';
import { federation } from '../../src';
import { FIXTURES } from './build';

export type ServedRequest = { path: string; authorization?: string; status: number };

export type StaticServer = {
  origin: string;
  requests: ServedRequest[];
  close: () => Promise<void>;
};

/**
 * Serves `root`. With `authorization`, any request without that exact
 * Authorization header gets a 401.
 */
export async function serveDirectory(
  root: string,
  { authorization }: { authorization?: string } = {}
): Promise<StaticServer> {
  const requests: ServedRequest[] = [];
  const cors = {
    'access-control-allow-origin': '*',
    ...(authorization ? { 'access-control-allow-headers': 'authorization' } : {}),
  };
  const server = createServer(async (request, response) => {
    if (authorization && request.method === 'OPTIONS') {
      response.writeHead(204, cors).end();
      return;
    }
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    const reply = (status: number, headers: Record<string, string> = {}, content?: Buffer) => {
      requests.push({ path: pathname, authorization: request.headers.authorization, status });
      response.writeHead(status, { ...cors, ...headers }).end(content);
    };
    if (authorization && request.headers.authorization !== authorization) {
      reply(401);
      return;
    }
    // Chrome asks for this on every navigation; a 404 would show up as a console error.
    if (pathname === '/favicon.ico') {
      reply(204);
      return;
    }

    const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    const filePath = path.resolve(root, relativePath);

    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
      reply(403);
      return;
    }

    try {
      const content = await readFile(filePath);
      const contentType = filePath.endsWith('.html')
        ? 'text/html'
        : filePath.endsWith('.js')
          ? 'application/javascript'
          : filePath.endsWith('.css')
            ? 'text/css'
            : 'application/octet-stream';
      reply(200, { 'content-type': contentType }, content);
    } catch {
      reply(404);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not bind');

  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** `fixture` is a name under integration/fixtures, or an absolute root. */
export async function buildFixtureTo(
  fixture: string,
  outDir: string,
  mfOptions: Parameters<typeof federation>[0] | Parameters<typeof federation>[0][]
): Promise<void> {
  const result = await build({
    root: path.resolve(FIXTURES, fixture),
    logLevel: 'silent',
    build: {
      outDir,
      emptyOutDir: true,
      target: 'chrome91',
    },
    plugins: (Array.isArray(mfOptions) ? mfOptions : [mfOptions]).map((options) =>
      federation(options)
    ),
  });

  if (Array.isArray(result)) throw new Error('Expected a single Rollup output');
}

export async function createBrowser() {
  return chromium.launch({ channel: 'chrome', headless: true });
}

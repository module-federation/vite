import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'vite';
import { federation } from '../../src';
import { FIXTURES } from './build';

export type StaticServer = {
  origin: string;
  close: () => Promise<void>;
};

export async function serveDirectory(root: string): Promise<StaticServer> {
  const server = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    // Chrome asks for this on every navigation; a 404 would show up as a console error.
    if (pathname === '/favicon.ico') {
      response.writeHead(204).end();
      return;
    }

    const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    const filePath = path.resolve(root, relativePath);

    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }

    try {
      const content = await readFile(filePath);
      const contentType = filePath.endsWith('.html')
        ? 'text/html'
        : filePath.endsWith('.js')
          ? 'application/javascript'
          : 'application/octet-stream';
      response.writeHead(200, {
        'access-control-allow-origin': '*',
        'content-type': contentType,
      });
      response.end(content);
    } catch {
      response.writeHead(404).end();
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

import { ViteDevServer } from 'vite';

const MF_HMR_ENDPOINT = '__mf_hmr';

export function onServerReady(server: ViteDevServer, cb: () => void): void {
  if (server.httpServer?.listening) {
    cb();
  } else {
    server.httpServer?.on('listening', cb);
  }
}

export function getMfHmrPath(base = '/'): string {
  const pathname = getBasePathname(base);
  const normalizedBase = `/${pathname}/`.replace(/\/+/g, '/');
  return `${normalizedBase.replace(/\/$/, '')}/${MF_HMR_ENDPOINT}`.replace(/\/+/g, '/');
}

export function matchesMfHmrUrl(url: string | undefined, base = '/'): boolean {
  if (!url) return false;
  const pathname = new URL(url, 'http://mf.local').pathname;
  return pathname === getMfHmrPath(base) || pathname === `/${MF_HMR_ENDPOINT}`;
}

export function deriveMfHmrUrl(entry: string): string | null {
  try {
    return new URL(MF_HMR_ENDPOINT, entry).toString();
  } catch {
    return null;
  }
}

function getBasePathname(base: string): string {
  try {
    return new URL(base).pathname;
  } catch {
    return base;
  }
}

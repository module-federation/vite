import { ViteDevServer } from 'vite';

export { createMfLogger, type MfLogger } from './logger';

export function onServerReady(server: ViteDevServer, cb: () => void): void {
  if (server.httpServer?.listening) {
    cb();
  } else {
    server.httpServer?.on('listening', cb);
  }
}

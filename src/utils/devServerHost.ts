import { isIPv6 } from 'node:net';

const UNSPECIFIED_HOSTS = new Set(['0.0.0.0', '::']);

/**
 * Hostname for client-facing HTTP/WS origins built from Vite `server.host`.
 *
 * Unspecified bind addresses (`0.0.0.0`, `::`) map to `localhost`, matching
 * Vite's own printed local URL. IPv6 addresses are wrapped in brackets so
 * `http://[::1]:5173` / `ws://[::1]:5173` parse as valid URLs.
 */
export function formatDevServerHostForOrigin(host: unknown): string {
  if (typeof host !== 'string' || UNSPECIFIED_HOSTS.has(host)) {
    return 'localhost';
  }
  if (host.startsWith('[') && host.endsWith(']')) {
    return host;
  }
  return isIPv6(host) ? `[${host}]` : host;
}

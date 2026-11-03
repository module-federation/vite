const VITE_ID_PREFIX = '/@id/';
const VITE_NULL_BYTE_PLACEHOLDER = '__x00__';

/**
 * Convert the module ids used by Vite's HTTP runner transport back to the
 * ids accepted by Node's package resolver.
 *
 * Vite prefixes optimized bare imports with `/@id/` and encodes virtual
 * modules with `/@id/__x00__`. The runner endpoint may return either form
 * when a module cannot be resolved through its environment channel.
 */
export function normalizeRunnerModuleId(id: string): string {
  const decoded = id.startsWith(VITE_ID_PREFIX) ? id.slice(VITE_ID_PREFIX.length) : id;
  return decoded.startsWith(VITE_NULL_BYTE_PLACEHOLDER)
    ? `\0${decoded.slice(VITE_NULL_BYTE_PLACEHOLDER.length)}`
    : decoded;
}

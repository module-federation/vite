import * as path from 'node:path';

/**
 * Strip `[hash]` / `[hash:N]` placeholders for stable serve URLs.
 * Matches browser remoteEntry serve behavior (pluginAddEntry / manifest).
 */
export function resolveDevHashEntryFileName(fileName: string): string {
  if (!fileName.includes('[hash')) return fileName;

  const normalized = fileName.replace(/(?:[._-]?\[hash(?::\d+)?\])/g, '');
  const baseName = path.basename(normalized);

  return path.extname(baseName) ? normalized : `${normalized}.js`;
}

/**
 * Build the SSR companion filename for a browser remoteEntry filename.
 * `remoteEntry.js` → `remoteEntry.ssr.js`
 * `remoteEntry-abc.js` → `remoteEntry-abc.ssr.js`
 */
export function getSsrRemoteEntryFileName(browserFilename: string): string {
  const ext = browserFilename.match(/\.[^.]+$/)?.[0] || '.js';
  const base = browserFilename.slice(0, browserFilename.length - ext.length);
  return `${base}.ssr${ext}`;
}

/**
 * Resolve the SSR remoteEntry filename used for emit, middleware, and manifest.
 *
 * When `filename` contains a `[hash]` placeholder, strip it so SSR stays on a
 * stable name (`remoteEntry.ssr.js`) — the same stripping browser serve uses.
 * Otherwise, prefer an already-emitted browser chunk name when provided so the
 * SSR companion tracks the concrete browser remoteEntry file.
 */
export function resolveSsrRemoteEntryFileName(
  filename: string,
  browserRemoteEntryFile?: string | null
): string {
  if (filename.includes('[hash')) {
    return getSsrRemoteEntryFileName(resolveDevHashEntryFileName(filename));
  }
  if (browserRemoteEntryFile) {
    return getSsrRemoteEntryFileName(browserRemoteEntryFile);
  }
  return getSsrRemoteEntryFileName(filename);
}

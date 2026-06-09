/**
 * Rebase an import path for a bootstrap file that moved from root into `dir`.
 *
 * When entryFileNames places entries in a subdirectory (e.g. `static/js/`),
 * the bootstrap file moves there too. Paths that resolved from the HTML root
 * must resolve from the new directory instead.
 *
 * Cases: `/static/js/hostInit.js` → `./hostInit.js` (strip dir prefix)
 *        `./src/main.tsx`          → `../../src/main.tsx` (climb back up for each dir level)
 *        `https://cdn.example.com` → unchanged         (absolute URL)
 */
export function rebaseImport(importSrc: string, dir: string): string {
  if (!dir) return importSrc;

  if (isAbsoluteUrl(importSrc)) return importSrc;

  const normalizedDir = dir.replace(/^\/+|\/+$/g, '');
  if (!normalizedDir) return importSrc;

  const stripDirPrefix = (src: string, prefix: string) => {
    if (src === prefix) return '';
    if (src.startsWith(prefix + '/')) return src.slice(prefix.length);
  };

  const absoluteRemainder = stripDirPrefix(importSrc, '/' + normalizedDir);
  if (absoluteRemainder !== undefined) {
    const remainder = absoluteRemainder.replace(/^\/+/, '');
    return remainder ? './' + remainder : './';
  }

  const relativeRemainder = stripDirPrefix(importSrc, normalizedDir);
  if (relativeRemainder !== undefined) {
    const remainder = relativeRemainder.replace(/^\/+/, '');
    return remainder ? './' + remainder : './';
  }

  const upLevels = normalizedDir.split('/').filter(Boolean).length;
  const prefix = upLevels > 0 ? '../'.repeat(upLevels) : './';

  if (importSrc.startsWith('./')) {
    return prefix + importSrc.slice('./'.length);
  }
  if (importSrc.startsWith('/')) {
    return prefix + importSrc.slice('/'.length);
  }

  return prefix + importSrc;
}

export function normalizePathForImport(path: string): string {
  return path.replace(/\\/g, '/');
}

export const EXTERNAL_URL_RE = /^(?:[a-z]+:|\/\/)/i;

export function isAbsoluteUrl(src: string): boolean {
  if (/^[a-z]:[\\/]/i.test(src)) return false;
  return EXTERNAL_URL_RE.test(src);
}

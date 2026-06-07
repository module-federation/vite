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

  const absPrefix = '/' + dir;
  if (importSrc.startsWith(absPrefix)) {
    const remainder = importSrc.slice(absPrefix.length);
    return remainder ? './' + remainder : './';
  }

  if (importSrc.startsWith(dir)) {
    const remainder = importSrc.slice(dir.length);
    return remainder ? './' + remainder : './';
  }

  const upLevels = dir.split('/').filter(Boolean).length;
  const prefix = upLevels > 0 ? '../'.repeat(upLevels) : './';

  if (importSrc.startsWith('./')) {
    return prefix + importSrc.slice('./'.length);
  }
  if (importSrc.startsWith('/')) {
    return prefix + importSrc.slice('/'.length);
  }

  return prefix + importSrc;
}

export const EXTERNAL_URL_RE = /^(?:[a-z]+:|\/\/)/i;

export function isAbsoluteUrl(src: string): boolean {
  return EXTERNAL_URL_RE.test(src);
}

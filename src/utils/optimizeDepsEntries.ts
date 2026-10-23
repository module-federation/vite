/**
 * Appends generated scanner entries to the user's `optimizeDeps.entries`, or to
 * Vite's default entries when the user set none. Order is kept, duplicates dropped.
 * include/exclude are left to Vite: since 5.1 its optimizer config hash dedupes
 * and sorts them itself.
 */
export function mergeOptimizeDepsEntries(
  userEntries: string | readonly string[] | undefined,
  generatedEntries: readonly string[],
  defaultEntries: readonly string[]
): string[] {
  const base =
    userEntries === undefined
      ? defaultEntries
      : typeof userEntries === 'string'
        ? [userEntries]
        : userEntries;
  return [...new Set([...base, ...generatedEntries])];
}

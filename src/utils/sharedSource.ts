import type { NormalizedShared } from './normalizeModuleFederationOptions';
import { getPackageName, getPackageNameFromNodeModulePath } from './packageUtils';
import {
  getCommonSharedSubpaths,
  getNodeModulesSuffix,
  normalizeNodeModulePath,
  stripViteFsPrefix,
} from './pathNormalization';
import { findSharedKey } from './sharedKeyMatcher';

/** Cache entry identity for one shared configuration and resolution environment. */
export function createSharedSourceResolver(shared: NormalizedShared | undefined) {
  const cache = new Map<string, string | undefined>();

  return async function getSharedSource(
    source: string,
    resolveEntry: (request: string) => Promise<string | undefined>
  ): Promise<string | undefined> {
    if (source.startsWith('\0') || source.includes('#')) return;
    // Vite transport queries preserve module identity; resource queries belong to its loaders.
    const queryIndex = source.indexOf('?');
    const query = queryIndex === -1 ? '' : source.slice(queryIndex + 1);
    if (
      query &&
      [...new URLSearchParams(query).keys()].some((key) => !['v', 't', 'import'].includes(key))
    )
      return;
    if (findSharedKey(source, shared)) return source;
    const suffix = getNodeModulesSuffix(source);
    if (!suffix || !shared) return;

    const normalizedSource = stripViteFsPrefix(normalizeNodeModulePath(source));
    if (cache.has(normalizedSource)) return cache.get(normalizedSource);

    // Vite can re-enter resolution while an earlier lookup is pending. Sharing
    // that promise can make the resolver wait on itself, so cache completed results only.
    const result = await (async () => {
      const packageName = getPackageNameFromNodeModulePath(source);
      if (!packageName) return;
      const candidates = new Set<string>();
      if (findSharedKey(packageName, shared)) candidates.add(packageName);
      if (findSharedKey(suffix, shared)) candidates.add(suffix);
      for (const key of Object.keys(shared)) {
        if (getPackageName(key) !== packageName) continue;
        if (!key.endsWith('/')) candidates.add(key);
        for (const subpath of getCommonSharedSubpaths(key)) {
          if (findSharedKey(subpath, shared)) candidates.add(subpath);
        }
      }

      // Match the entry file, not just its containing package: internal files can
      // expose a different API. Equivalent entries may live in separate installations.
      if (candidates.size === 0) return;
      const resolvedSource = await resolveEntry(normalizedSource);
      if (!resolvedSource) return;
      for (const candidate of candidates) {
        const key = findSharedKey(candidate, shared);
        if (!key) continue;
        const entry = await resolveEntry(candidate);
        if (!entry) continue;
        if (normalizeNodeModulePath(entry) === normalizeNodeModulePath(resolvedSource))
          return candidate;
        if (getNodeModulesSuffix(entry) === suffix) {
          return candidate;
        }
      }
    })();
    cache.set(normalizedSource, result);
    return result;
  };
}

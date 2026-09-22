import * as path from 'node:path';
import type { HookHandler, Plugin } from 'vite';
import type { NormalizedShared } from './normalizeModuleFederationOptions';
import {
  getPackageName,
  getPackageNameFromNodeModulePath,
  isPackageExportAvailable,
} from './packageUtils';
import {
  getCommonSharedSubpaths,
  getNodeModulesSuffix,
  normalizeNodeModulePath,
  stripViteFsPrefix,
} from './pathNormalization';
import { findSharedKey } from './sharedKeyMatcher';

type ResolveIdHook = HookHandler<NonNullable<Plugin['resolveId']>>;
type ResolveContext = Pick<ThisParameterType<ResolveIdHook>, 'resolve'> & {
  environment?: object;
};
type ResolveOptions = Partial<Parameters<ResolveIdHook>[2]> & {
  // Hook metadata from older Vite versions still affects entry identity.
  scan?: boolean;
  attributes?: Record<string, string>;
};

/** Identify shared entries through Vite, with a cache scoped to this federation instance. */
export function createSharedSourceResolver(
  shared: NormalizedShared,
  getResolutionConfig: (
    context: ResolveContext,
    options: ResolveOptions
  ) => { root: string; conditions: string[] }
) {
  const caches = new Map<object | boolean, Map<string, string | undefined>>();

  async function matchEntry(
    source: string,
    suffix: string,
    resolveEntry: (request: string) => Promise<string | undefined>
  ): Promise<string | undefined> {
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
    const resolvedSource = await resolveEntry(source);
    if (!resolvedSource) return;
    for (const candidate of candidates) {
      const entry = await resolveEntry(candidate);
      if (!entry) continue;
      const shareKey = findSharedKey(candidate, shared) ?? candidate;
      const allowNodeModulesSuffixMatch =
        shared[shareKey]?.shareConfig?.allowNodeModulesSuffixMatch === true;
      if (
        normalizeNodeModulePath(entry) === normalizeNodeModulePath(resolvedSource) ||
        (allowNodeModulesSuffixMatch && getNodeModulesSuffix(entry) === suffix)
      )
        return candidate;
    }
  }

  return {
    clear() {
      // Pending lookups retain their old cache and cannot repopulate a new build.
      caches.clear();
    },
    async resolve(
      context: ResolveContext,
      source: string,
      options: ResolveOptions = {}
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
      if (!suffix) return;

      const normalizedSource = stripViteFsPrefix(normalizeNodeModulePath(source));
      // Vite 6+ shares plugins across environments; Vite 5 identifies SSR via options.
      const environment = context.environment ?? !!options.ssr;
      // Other resolution modes or plugin options may select a different entry.
      const cacheable =
        !options.isEntry &&
        !options.scan &&
        (!options.kind || options.kind === 'import-statement') &&
        Object.keys(options.attributes ?? {}).length === 0 &&
        Object.keys(options.custom ?? {}).length === 0;
      let cache = cacheable ? caches.get(environment) : undefined;
      if (cacheable && !cache) {
        cache = new Map();
        caches.set(environment, cache);
      }
      if (cache?.has(normalizedSource)) return cache.get(normalizedSource);

      const { root, conditions } = getResolutionConfig(context, options);
      const result = await matchEntry(normalizedSource, suffix, async (request) => {
        // Rolldown can retain errors from speculative this.resolve() calls even
        // when caught. A file path does not imply a public package export.
        if (
          !path.isAbsolute(request) &&
          !isPackageExportAvailable(request, { cwd: root, conditions })
        )
          return undefined;
        try {
          const resolved = await context.resolve(request, path.join(root, 'package.json'), {
            ...options,
            skipSelf: true,
            custom: { ...options.custom, __mfSharedEntryLookup: true },
          });
          return resolved && !resolved.external ? resolved.id : undefined;
        } catch {
          // A prefix can suggest a private or missing export. It is not a shared entry.
          return undefined;
        }
      });
      // Vite can re-enter resolution while an earlier lookup is pending. Sharing
      // that promise can make the resolver wait on itself, so cache completed results only.
      cache?.set(normalizedSource, result);
      return result;
    },
  };
}

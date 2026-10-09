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
  removeTrailingSlash,
  stripViteFsPrefix,
} from './pathNormalization';
import { findSharedKey, getSharedRequest } from './sharedKeyMatcher';

type ResolveIdHook = HookHandler<NonNullable<Plugin['resolveId']>>;
type ResolveContext = Pick<ThisParameterType<ResolveIdHook>, 'resolve'> & {
  environment?: object;
};
type ResolveOptions = Partial<Parameters<ResolveIdHook>[2]> & {
  // Hook metadata from older Vite versions still affects entry identity.
  scan?: boolean;
  attributes?: Record<string, string>;
};

// Workaround: rolldown <= 1.2.10 can drop `custom` from overlapping this.resolve() calls,
// so entry lookups are also recognized by their in-flight source and importer.
const pendingEntryLookups = new Map<string, number>();

const getEntryLookupKey = (source: string, importer: string | undefined) =>
  `${source}\0${importer}`;

/** Whether a resolveId call is one of the shared source resolver's own entry lookups. */
export function isSharedEntryLookup(
  source: string,
  importer: string | undefined,
  options: { custom?: Record<string, unknown> }
): boolean {
  return (
    options.custom?.__mfSharedEntryLookup === true ||
    pendingEntryLookups.has(getEntryLookupKey(source, importer))
  );
}

/**
 * Runs one of the plugin's own `this.resolve()` calls (a shared entry lookup, a
 * parse-barrier external probe), marked so `isSharedEntryLookup` recognizes it
 * and the share hooks neither proxy it nor register a used share for it.
 */
export async function resolveInternally(
  context: ResolveContext,
  source: string,
  importer: string | undefined,
  options: ResolveOptions = {}
) {
  const lookupKey = getEntryLookupKey(source, importer);
  pendingEntryLookups.set(lookupKey, (pendingEntryLookups.get(lookupKey) ?? 0) + 1);
  try {
    return await context.resolve(source, importer, {
      ...options,
      skipSelf: true,
      custom: { ...options.custom, __mfSharedEntryLookup: true },
    });
  } finally {
    const remaining = pendingEntryLookups.get(lookupKey)! - 1;
    if (remaining) pendingEntryLookups.set(lookupKey, remaining);
    else pendingEntryLookups.delete(lookupKey);
  }
}

/** Identify shared entries through Vite, with a cache scoped to this federation instance. */
export function createSharedSourceResolver(
  shared: NormalizedShared,
  getResolutionConfig: (
    context: ResolveContext,
    options: ResolveOptions
  ) => { root: string; conditions: string[] }
) {
  const caches = new Map<object | boolean, Map<string, string | undefined>>();
  // A trailing-slash share key claims every subpath of a package, but `resolveId` is speculative:
  // plugins probe specifiers that do not exist, and another resolver can rewrite a failed probe
  // into a *different* specifier that still falls under the prefix — @embroider/vite retries any
  // failed `.js` request as the same path with `.hbs` to find Ember's colocated templates.
  // Trusting that guess as a shared entry commits a loadShare module whose body re-imports the
  // specifier, so the build fails on a module nobody imported instead of reporting the real
  // resolution error. The bare base and the package's own well-known subpaths stay trusted
  // outright, as before: only a derived, non-exact subpath match is confirmed first.
  const wildcardSubpathCaches = new Map<object | boolean, Map<string, boolean>>();

  async function resolveEntry(
    context: ResolveContext,
    request: string,
    options: ResolveOptions,
    { root, conditions }: ReturnType<typeof getResolutionConfig>
  ): Promise<string | undefined> {
    // Rolldown can retain errors from speculative this.resolve() calls even
    // when caught. A file path does not imply a public package export.
    if (!path.isAbsolute(request) && !isPackageExportAvailable(request, { cwd: root, conditions }))
      return undefined;
    const importer = path.join(root, 'package.json');
    try {
      const resolved = await resolveInternally(context, request, importer, options);
      return resolved && !resolved.external ? resolved.id : undefined;
    } catch {
      // A prefix can suggest a private or missing export. It is not a shared entry.
      return undefined;
    }
  }

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
      const request = getSharedRequest(key, shared[key]);
      if (getPackageName(request) !== packageName) continue;
      if (!request.endsWith('/')) candidates.add(request);
      for (const subpath of getCommonSharedSubpaths(request)) {
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
      wildcardSubpathCaches.clear();
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
      // Vite 6+ shares plugins across environments; Vite 5 identifies SSR via options.
      const environment = context.environment ?? !!options.ssr;
      // Other resolution modes or plugin options may select a different entry.
      const cacheable =
        !options.isEntry &&
        !options.scan &&
        (!options.kind || options.kind === 'import-statement') &&
        Object.keys(options.attributes ?? {}).length === 0 &&
        Object.keys(options.custom ?? {}).length === 0;
      const getCache = <T>(byEnvironment: Map<object | boolean, Map<string, T>>) => {
        if (!cacheable) return;
        let cache = byEnvironment.get(environment);
        if (!cache) {
          cache = new Map();
          byEnvironment.set(environment, cache);
        }
        return cache;
      };

      const directKey = findSharedKey(source, shared);
      if (directKey) {
        const request = getSharedRequest(directKey, shared[directKey]);
        const isDerivedSubpath =
          request.endsWith('/') &&
          source !== removeTrailingSlash(request) &&
          !getCommonSharedSubpaths(request).includes(source);
        if (!isDerivedSubpath) return source;
        const cache = getCache(wildcardSubpathCaches);
        let resolvable = cache?.get(source);
        if (resolvable === undefined) {
          const config = getResolutionConfig(context, options);
          resolvable = (await resolveEntry(context, source, options, config)) !== undefined;
          // Cache completed results only: see the re-entrancy note below.
          cache?.set(source, resolvable);
        }
        return resolvable ? source : undefined;
      }
      const suffix = getNodeModulesSuffix(source);
      if (!suffix) return;

      const normalizedSource = stripViteFsPrefix(normalizeNodeModulePath(source));
      const cache = getCache(caches);
      if (cache?.has(normalizedSource)) return cache.get(normalizedSource);

      const config = getResolutionConfig(context, options);
      const result = await matchEntry(normalizedSource, suffix, (request) =>
        resolveEntry(context, request, options, config)
      );
      // Vite can re-enter resolution while an earlier lookup is pending. Sharing
      // that promise can make the resolver wait on itself, so cache completed results only.
      cache?.set(normalizedSource, result);
      return result;
    },
  };
}

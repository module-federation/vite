import * as path from 'node:path';
import type { HookHandler, Plugin } from 'vite';
import type { NormalizedShared } from './normalizeModuleFederationOptions';
import {
  getPackageExportSpecifiersForFile,
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

// Workaround: rolldown <= 1.2.10 can mix up options from overlapping this.resolve() calls,
// so entry lookups are recognized by their in-flight source and importer instead.
const pendingEntryLookups = new Map<string, number>();

const getEntryLookupKey = (source: string, importer: string | undefined) =>
  `${source}\0${importer}`;

/**
 * Rolldown saves each this.resolve() call's options under the map's current size and deletes the
 * entry when the call settles, so an overlapping call can receive the wrong `custom` metadata.
 * Taking the first free key keeps every in-flight entry intact. A no-op when the internals differ.
 */
export function patchRolldownResolveOptionKeys(context: unknown) {
  const data = (context as { data?: Record<string, unknown> } | undefined)?.data;
  const map = data?.resolveOptionsMap;
  if (!data || !(map instanceof Map) || typeof data.saveResolveOptions !== 'function') return;
  if (data.__mfFreeKeyPatch) return;
  data.saveResolveOptions = (options: unknown) => {
    let index = map.size;
    while (map.has(index)) index++;
    map.set(index, options);
    return index;
  };
  data.__mfFreeKeyPatch = true;
}

/** Whether a resolveId call is one of the shared source resolver's own entry lookups. */
export function isSharedEntryLookup(source: string, importer: string | undefined): boolean {
  return pendingEntryLookups.has(getEntryLookupKey(source, importer));
}

/**
 * Runs one of the plugin's own `this.resolve()` calls (a shared entry lookup, a
 * parse-barrier external probe), tracked so `isSharedEntryLookup` recognizes it
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
    entryOptions: { cwd: string; conditions: string[] },
    resolveEntry: (request: string) => Promise<string | undefined>
  ): Promise<string | undefined> {
    const packageName = getPackageNameFromNodeModulePath(source);
    if (!packageName) return;
    const candidates = new Set<string>();
    if (findSharedKey(packageName, shared)) candidates.add(packageName);
    // `suffix` is the resolved file's path below the last `node_modules/`, which is a *file path*,
    // not necessarily a specifier. It only names something the package publishes when `exports`
    // leaves its files where they sit on disk. A package that remaps directories
    // (`"./*": "./dist/*.js"`) publishes `pkg/button` and never `pkg/dist/button.js`, so taking the
    // path as a specifier both misses the entry and probes a request the package cannot resolve —
    // and a failed probe is not free: another resolver can rewrite it into a different specifier
    // that still falls under a shared prefix (@embroider/vite retries a failed `.js` as `.hbs` to
    // find Ember's colocated templates), which then gets adopted as a share nobody imported.
    // Reversing `exports` instead yields only specifiers that resolve back to this file, and falls
    // back to the path itself for packages without `exports`, where the path *is* the specifier.
    const packageSubpath = suffix.slice(packageName.length + 1);
    if (packageSubpath) {
      // Read the copy that holds `source`, not whichever one the root resolves, so a nested
      // install reverses its own `exports`.
      for (const specifier of getPackageExportSpecifiersForFile(packageName, packageSubpath, {
        ...entryOptions,
        fromResolvedEntry: source,
      })) {
        if (findSharedKey(specifier, shared)) candidates.add(specifier);
      }
    }
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
      const result = await matchEntry(
        normalizedSource,
        suffix,
        { cwd: config.root, conditions: config.conditions },
        (request) => resolveEntry(context, request, options, config)
      );
      // Vite can re-enter resolution while an earlier lookup is pending. Sharing
      // that promise can make the resolver wait on itself, so cache completed results only.
      cache?.set(normalizedSource, result);
      return result;
    },
  };
}

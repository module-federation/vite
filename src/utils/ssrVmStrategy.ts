/**
 * vm.SourceTextModule strategy for loading remote SSR entries.
 *
 * Unlike the temp-file strategy (which rewrites bare shared imports to
 * host-resolved file:// paths at fetch time), this strategy evaluates the
 * remote's ESM graph with `vm.SourceTextModule` in the current context and
 * resolves bare imports through a linker, in order:
 *
 *  1. The host's federation share scope — `instance.loadShare(name)` on the
 *     global `__FEDERATION__` instances. This restores real share-scope
 *     semantics (version negotiation, loaded-first reuse) on the server.
 *  2. The build-time `resolvedShared` file map (same source as the temp-file
 *     strategy) as a fallback when no instance shares the package.
 *  3. Plain host `import(specifier)` for everything else (node builtins,
 *     packages the remote expects the host to provide).
 *
 * Requires Node with `--experimental-vm-modules`; callers must check
 * `isVmStrategyAvailable()` and fall back to the temp-file strategy when the
 * API is missing.
 */
import { neutralizeBrowserPreloadHelpers, SsrEntryHttpError } from './ssrEntryLoader';
import { DEFAULT_SSR_FETCH_TIMEOUT_MS, fetchWithTimeout } from './fetchWithTimeout';

interface VmStrategyOptions {
  resolvedShared: Record<string, string>;
  shareScopeName: string;
  versionKey: string;
  fetchTimeoutMs?: number;
  cacheContext: object;
  federationInstance?: object;
}

// Minimal structural typings for the experimental vm module APIs so this file
// compiles without @types/node exposing them (they are flag-gated).
interface VmModule {
  status: 'unlinked' | 'linking' | 'linked' | 'evaluating' | 'evaluated' | 'errored';
  identifier: string;
  namespace: unknown;
  link(linker: Linker): Promise<void>;
  evaluate(): Promise<void>;
}

type Linker = (specifier: string, referencingModule: VmModule) => VmModule | Promise<VmModule>;

interface VmApi {
  SourceTextModule: new (
    code: string,
    options: {
      identifier?: string;
      initializeImportMeta?: (meta: { url?: string }) => void;
      importModuleDynamically?: (
        specifier: string,
        referencingModule: VmModule
      ) => VmModule | Promise<VmModule>;
    }
  ) => VmModule;
  SyntheticModule: new (
    exportNames: string[],
    evaluateCallback: () => void,
    options?: { identifier?: string }
  ) => VmModule & { setExport(name: string, value: unknown): void };
}

let vmApiPromise: Promise<VmApi | null> | undefined;
async function getVmApi(): Promise<VmApi | null> {
  if (!vmApiPromise) {
    vmApiPromise = (async () => {
      try {
        const vm = (await import(/* @vite-ignore */ 'vm')) as unknown as Partial<VmApi>;
        if (typeof vm.SourceTextModule !== 'function' || typeof vm.SyntheticModule !== 'function') {
          return null;
        }
        return vm as VmApi;
      } catch {
        return null;
      }
    })();
  }
  return vmApiPromise;
}

export async function isVmStrategyAvailable(): Promise<boolean> {
  return (await getVmApi()) !== null;
}

// ---------------------------------------------------------------------------
// Share-scope resolution for bare specifiers
// ---------------------------------------------------------------------------

interface FederationInstanceLike {
  options?: {
    shared?: Record<string, { scope?: string | string[] } | undefined>;
  };
  loadShare?: (name: string) => Promise<false | (() => unknown | undefined) | undefined>;
}

function getFederationInstances(): FederationInstanceLike[] {
  const federation = (
    globalThis as { __FEDERATION__?: { __INSTANCES__?: FederationInstanceLike[] } }
  ).__FEDERATION__;
  return federation?.__INSTANCES__ ?? [];
}

/**
 * Resolve a bare specifier to a module namespace: share scope first, then the
 * build-time resolvedShared file map, then plain host import.
 */
async function loadBareModule(specifier: string, options: VmStrategyOptions): Promise<unknown> {
  const owner = options.federationInstance as FederationInstanceLike | undefined;
  const instances = owner ? [owner] : getFederationInstances();
  for (const instance of instances) {
    if (typeof instance?.loadShare !== 'function') continue;
    // Only consult instances that actually declare the package as shared —
    // loadShare on an unknown package can register it as a side effect.
    const shared = instance.options?.shared?.[specifier];
    if (!shared) continue;
    const scopes = Array.isArray(shared.scope) ? shared.scope : [shared.scope ?? 'default'];
    if (!scopes.includes(options.shareScopeName)) continue;
    try {
      const factory = await instance.loadShare(specifier);
      if (typeof factory === 'function') {
        const shared = factory();
        if (shared) return shared;
      }
    } catch {
      // Try the next instance / fallback chain.
    }
  }

  const resolvedPath = options.resolvedShared[specifier];
  if (resolvedPath) {
    return import(/* @vite-ignore */ `file://${resolvedPath}`);
  }

  return import(/* @vite-ignore */ specifier);
}

function createSyntheticModule(vm: VmApi, specifier: string, namespace: unknown): VmModule {
  const source =
    namespace && typeof namespace === 'object'
      ? (namespace as Record<string, unknown>)
      : { default: namespace };
  const exportNames = new Set(Object.keys(source));
  exportNames.add('default');

  const syntheticModule = new vm.SyntheticModule(
    [...exportNames],
    () => {
      for (const exportName of exportNames) {
        if (exportName === 'default') {
          syntheticModule.setExport(
            'default',
            source.default !== undefined ? source.default : namespace
          );
        } else {
          syntheticModule.setExport(exportName, source[exportName]);
        }
      }
    },
    { identifier: `mf-shared:${specifier}` }
  );
  return syntheticModule;
}

// ---------------------------------------------------------------------------
// HTTP module graph
// ---------------------------------------------------------------------------

// `${versionKey}::${url}` → module. Version-keyed so a remote redeploy loads a
// fresh graph instead of the cached one.
const httpModuleCache = new Map<string, Promise<VmModule>>();
// Evaluated entry namespaces, same keying.
const namespaceCache = new Map<string, Promise<unknown>>();

const contextIds = new WeakMap<object, number>();
let nextContextId = 1;

function getContextId(context: object): number {
  let id = contextIds.get(context);
  if (id === undefined) {
    id = nextContextId++;
    contextIds.set(context, id);
  }
  return id;
}

function getVmCacheContextKey(options: VmStrategyOptions): string {
  return JSON.stringify([
    getContextId(options.cacheContext),
    options.shareScopeName,
    Object.entries(options.resolvedShared).sort(([left], [right]) => left.localeCompare(right)),
  ]);
}

function getBodyPreview(body: string): string {
  return body.slice(0, 240).replace(/\s+/g, ' ').trim();
}

async function fetchModuleSource(url: string, fetchTimeoutMs?: number): Promise<string> {
  const res = await fetchWithTimeout(url, {}, fetchTimeoutMs);
  const text = await res.text();
  if (!res.ok) {
    throw new SsrEntryHttpError(url, res.status, res.statusText, getBodyPreview(text));
  }
  return neutralizeBrowserPreloadHelpers(text);
}

function isHttpUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

/** Resolve a specifier against the referencing module's URL; null for bare specifiers. */
function resolveSpecifierUrl(specifier: string, referencerUrl: string): string | null {
  if (isHttpUrl(specifier)) return specifier;
  if (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/')) {
    return new URL(specifier, referencerUrl).href;
  }
  return null;
}

function getHttpModule(vm: VmApi, url: string, options: VmStrategyOptions): Promise<VmModule> {
  const cacheKey = JSON.stringify([
    getVmCacheContextKey(options),
    options.fetchTimeoutMs ?? DEFAULT_SSR_FETCH_TIMEOUT_MS,
    options.versionKey,
    url,
  ]);
  if (!httpModuleCache.has(cacheKey)) {
    httpModuleCache.set(
      cacheKey,
      (async () => {
        const code = await fetchModuleSource(url, options.fetchTimeoutMs);
        return new vm.SourceTextModule(code, {
          identifier: url,
          initializeImportMeta(meta) {
            meta.url = url;
          },
          importModuleDynamically: (specifier, referencingModule) =>
            importDynamically(vm, specifier, referencingModule, options),
        });
      })().catch((error) => {
        httpModuleCache.delete(cacheKey);
        throw error;
      })
    );
  }
  return httpModuleCache.get(cacheKey)!;
}

async function linkModule(
  vm: VmApi,
  specifier: string,
  referencingModule: VmModule,
  options: VmStrategyOptions
): Promise<VmModule> {
  const url = resolveSpecifierUrl(specifier, referencingModule.identifier);
  if (url) return getHttpModule(vm, url, options);
  return createSyntheticModule(vm, specifier, await loadBareModule(specifier, options));
}

async function importDynamically(
  vm: VmApi,
  specifier: string,
  referencingModule: VmModule,
  options: VmStrategyOptions
): Promise<VmModule> {
  const linker: Linker = (spec, referencer) => linkModule(vm, spec, referencer, options);
  const module = await linker(specifier, referencingModule);
  if (module.status === 'unlinked') await module.link(linker);
  if (module.status === 'linked') await module.evaluate();
  return module;
}

/**
 * Load and evaluate a remote SSR entry as a `vm.SourceTextModule` graph and
 * return its namespace (the federation container with `init`/`get`).
 * Returns null when the vm module APIs are unavailable.
 */
export async function loadViaVmStrategy(
  entryUrl: string,
  options: VmStrategyOptions
): Promise<unknown | null> {
  const vm = await getVmApi();
  if (!vm) return null;

  const cacheKey = `${getVmCacheContextKey(options)}::${options.versionKey}::${entryUrl}`;
  if (!namespaceCache.has(cacheKey)) {
    namespaceCache.set(
      cacheKey,
      (async () => {
        const entryModule = await getHttpModule(vm, entryUrl, options);
        const linker: Linker = (specifier, referencingModule) =>
          linkModule(vm, specifier, referencingModule, options);
        if (entryModule.status === 'unlinked') await entryModule.link(linker);
        if (entryModule.status === 'linked') await entryModule.evaluate();
        return entryModule.namespace;
      })().catch((error) => {
        namespaceCache.delete(cacheKey);
        throw error;
      })
    );
  }
  return namespaceCache.get(cacheKey)!;
}

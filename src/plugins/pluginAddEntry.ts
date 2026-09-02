import * as fs from 'fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { Plugin, ResolvedConfig, Rollup } from 'vite';
import { normalizePathForImport, rebaseImport } from '../utils/buildPaths';
import { findRemoteEntryFile } from '../utils/bundleHelpers';
import { mapCodeToCodeWithSourcemap } from '../utils/mapCodeToCodeWithSourcemap';

import {
  findModuleImportSources,
  injectEntryScript,
  rewriteEntryScripts,
  sanitizeDevEntryPath,
} from '../utils/htmlEntryUtils';
import { mfWarn } from '../utils/logger';
import type { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { getNormalizeModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { hasPackageDependency } from '../utils/packageUtils';
import {
  decodeViteId,
  toViteEncodedId,
  VITE_ENCODED_NULL_BYTE_PREFIX,
  VITE_ID_PREFIX,
} from '../utils/VirtualModule';
import {
  addUsedRemote,
  getPreloadRemotes,
  getRemoteRegistration,
  getRuntimeRemoteId,
  getUsedRemotesMap,
  isDynamicOnlyRemote,
} from '../virtualModules/virtualRemotes';
import { getUsedShares } from '../virtualModules/virtualRemoteEntry';
import {
  getLoadShareModulePath,
  getProjectResolvedImportPath,
} from '../virtualModules/virtualShared_preBuild';
import {
  getModuleCacheGlobalKey,
  getRuntimeModuleCacheBootstrapCode,
  getRuntimeRemoteCachePrefix,
} from '../virtualModules/virtualRuntimeInitStatus';

interface AddEntryOptions {
  entryName: string;
  entryPath: string | (() => string);
  fileName?: string;
  inject?: NormalizedModuleFederationOptions['hostInitInjectLocation'];
  /** When true, skip the dev HTML-entry fallback (used for MF remotes whose index.html is never browser-requested). */
  forceClientInjected?: boolean;
  skipTransformFor?: string[];
  federationOptions?: NormalizedModuleFederationOptions;
}

// Tree-shaken shares deliberately keep their complete provider as a lazy
// fallback. Preloading every virtual MF chunk would fetch that fallback
// before runtime provider selection has a chance to choose the optimized
// provider — so `__prebuild__` chunks are always excluded.
// Virtual MF chunk file names vary in their underscore prefix depending on
// how the bundler sanitizes the virtual id (`_virtual_mf…`, `virtual_mf…`,
// `__virtual_mf…`), so match by substring.
const isPreloadableVirtualMfChunk = (name: string) =>
  name.includes('virtual_mf') && !name.includes('__prebuild__');

const HOST_INIT_PRELOAD_CHUNKS: ReadonlyArray<(name: string) => boolean> = [
  (name) => name === 'hostInit',
  (name) => name === 'remoteEntry',
  (name) => name === 'virtualExposes',
  isPreloadableVirtualMfChunk,
  (name) => name === 'index',
];

// Chunks the generated remote entry warms for its consumers as soon as it
// evaluates: everything its own container init/get path needs. Deliberately
// narrower than HOST_INIT_PRELOAD_CHUNKS — no 'index' (that can be the
// remote's standalone app entry), no exposes payloads (speculative for hosts
// that use only some exposes), and no loadShare wrappers (their static
// imports are full share payloads that stay unloaded whenever the consumer
// provides the share, e.g. singletons).
const isRemoteWarmupExcluded = (name: string) =>
  name.includes('__prebuild__') || name.includes('__loadShare__');
const REMOTE_ENTRY_WARMUP_CHUNKS: ReadonlyArray<(name: string) => boolean> = [
  (name) => name === 'hostInit',
  (name) => name === 'virtualExposes',
  (name) => isPreloadableVirtualMfChunk(name) && !isRemoteWarmupExcluded(name),
];

function getChunksByFileName(bundle: Rollup.OutputBundle) {
  return new Map(
    Object.values(bundle)
      .filter((chunk) => chunk.type === 'chunk')
      .map((chunk) => [chunk.fileName, chunk as Rollup.OutputChunk])
  );
}

// Breadth-first over the seed chunks plus their transitive static imports:
// modulepreload fetches only the named file, not its imports, so each
// static-import level of a preloaded chunk otherwise costs one serial round
// trip at init time.
function collectPreloadChunkFiles(
  chunksByFileName: Map<string, Rollup.OutputChunk>,
  seeds: Rollup.OutputChunk[],
  excludeFromClosure: (name: string) => boolean = (name) => name.includes('__prebuild__')
): string[] {
  const seenFiles = new Set<string>();
  const files: string[] = [];
  const queue = [...seeds];
  while (queue.length > 0) {
    const chunk = queue.shift()!;
    if (seenFiles.has(chunk.fileName)) continue;
    seenFiles.add(chunk.fileName);
    for (const imported of chunk.imports ?? []) {
      const importedChunk = chunksByFileName.get(imported);
      if (importedChunk && !excludeFromClosure(importedChunk.name)) {
        queue.push(importedChunk);
      }
    }
    files.push(chunk.fileName);
  }
  return files;
}

function escapeHtmlAttr(value: string) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function getExistingHrefSet(html: string) {
  return new Set(Array.from(html.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi), (match) => match[1]));
}

function injectHostInitPreloads(
  html: string,
  bundle: Rollup.OutputBundle,
  resolvePath: (fileName: string) => string,
  externalHrefs: string[] = []
) {
  const existingHrefs = getExistingHrefSet(html);
  const hrefs: string[] = [];
  for (const href of externalHrefs) {
    if (existingHrefs.has(href)) continue;
    existingHrefs.add(href);
    hrefs.push(href);
  }
  const chunksByFileName = getChunksByFileName(bundle);
  const seeds = Array.from(chunksByFileName.values()).filter((chunk) =>
    HOST_INIT_PRELOAD_CHUNKS.some((match) => match(chunk.name))
  );
  for (const fileName of collectPreloadChunkFiles(chunksByFileName, seeds)) {
    const href = resolvePath(fileName);
    if (existingHrefs.has(href)) continue;
    existingHrefs.add(href);
    hrefs.push(href);
  }

  if (hrefs.length === 0) return html;

  const tags = hrefs
    .map((href) => `<link rel="modulepreload" crossorigin href="${escapeHtmlAttr(href)}">`)
    .join('');
  return html.includes('</head>') ? html.replace('</head>', `${tags}</head>`) : `${tags}${html}`;
}

// A consumer discovers the remote entry's init/get chunk URLs one dynamic
// import at a time — and, being cross-origin, it cannot preload them itself.
// The remote's own build knows every hash, so the generated entry injects
// modulepreload links for its init-critical chunks as soon as it evaluates.
// Link-only: nothing is executed early, so load semantics are unchanged.
function appendRemoteEntryWarmup(bundle: Rollup.OutputBundle, entryFileName: string) {
  const chunksByFileName = getChunksByFileName(bundle);
  const entryChunk = chunksByFileName.get(entryFileName);
  if (!entryChunk || entryChunk.code.includes('__mfWarmupPath')) return;
  // Only chunks reachable from THIS entry: with several federation configs in
  // one build the bundle holds each config's hostInit/virtualExposes chunks,
  // and a bundle-wide name match would warm the other configs' files too.
  const reachable = new Set<string>();
  const walk = [entryChunk];
  while (walk.length > 0) {
    const chunk = walk.pop()!;
    if (reachable.has(chunk.fileName)) continue;
    reachable.add(chunk.fileName);
    for (const imported of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) {
      const importedChunk = chunksByFileName.get(imported);
      if (importedChunk) walk.push(importedChunk);
    }
  }
  const seeds = Array.from(reachable)
    .map((file) => chunksByFileName.get(file)!)
    .filter(
      (chunk) =>
        chunk.fileName !== entryFileName &&
        REMOTE_ENTRY_WARMUP_CHUNKS.some((match) => match(chunk.name))
    );
  const lastSlash = entryFileName.lastIndexOf('/');
  const entryDir = lastSlash !== -1 ? entryFileName.slice(0, lastSlash + 1) : '';
  const files = collectPreloadChunkFiles(chunksByFileName, seeds, isRemoteWarmupExcluded)
    .filter((file) => file !== entryFileName)
    .map((file) => rebaseImport(file, entryDir));
  if (files.length === 0) return;
  entryChunk.code += `
if (typeof document !== 'undefined' && document.head) {
  try {
    for (const __mfWarmupPath of ${JSON.stringify(files)}) {
      const __mfWarmupLink = document.createElement('link');
      __mfWarmupLink.rel = 'modulepreload';
      __mfWarmupLink.crossOrigin = '';
      __mfWarmupLink.href = new URL(__mfWarmupPath, import.meta.url).href;
      document.head.appendChild(__mfWarmupLink);
    }
  } catch (__mfWarmupError) {}
}
`;
}

function getFirstHtmlEntryFile(entryFiles: string[]): string | undefined {
  return entryFiles.find((file) => file.endsWith('.html'));
}

function stripQueryAndHash(file: string) {
  return file.split(/[?#]/)[0];
}

function isReactRouterClientRouteInput(file: string) {
  return /[?&]__react-router-build-client-route(?:[=&]|$)/.test(file);
}

function resolveDevHashEntryFileName(fileName: string) {
  if (!fileName.includes('[hash')) return fileName;

  const normalized = fileName.replace(/(?:[._-]?\[hash(?::\d+)?\])/g, '');
  const baseName = path.basename(normalized);

  return path.extname(baseName) ? normalized : `${normalized}.js`;
}

export function getBuildInput(config: any) {
  return config.build?.rollupOptions?.input ?? config.build?.rolldownOptions?.input;
}

function patchHashEntryFileName(
  output: any,
  entryName: string,
  fileName: string,
  defaultFileNames: string
) {
  for (const option of ['entryFileNames', 'chunkFileNames']) {
    const originalFileNames = output[option];
    output[option] = (chunkInfo: { name?: string }, ...args: unknown[]) => {
      if (chunkInfo?.name === entryName) return fileName;
      if (typeof originalFileNames === 'function') {
        return originalFileNames(chunkInfo, ...args);
      }
      return originalFileNames || defaultFileNames;
    };
  }
}

function patchHashEntryFileNames(config: any, entryName: string, fileName?: string) {
  if (!fileName?.includes?.('[hash')) return;
  fileName = fileName.replace(/(\[hash(?::\d+)?\])$/, '$1.js');
  config.build ??= {};
  config.build.rollupOptions ??= {};
  config.build.rolldownOptions ??= {};
  const assetsDir = config.build.assetsDir ?? 'assets';
  const defaultFileNames = `${assetsDir ? `${assetsDir}/` : ''}[name]-[hash].js`;

  const patchOutput = (output: any) =>
    patchHashEntryFileName(output, entryName, fileName, defaultFileNames);
  const patchBundlerOutput = (bundlerOptions: any) => {
    const output = bundlerOptions.output;
    if (Array.isArray(output)) {
      output.forEach(patchOutput);
      return;
    }
    patchOutput((bundlerOptions.output ??= {}));
  };

  patchBundlerOutput(config.build.rollupOptions);
  patchBundlerOutput(config.build.rolldownOptions);
  Object.values(config.environments ?? {}).forEach((environment) =>
    patchHashEntryFileNames(environment, entryName, fileName)
  );
}

const addEntry = ({
  entryName,
  entryPath,
  fileName,
  inject = 'entry',
  forceClientInjected,
  skipTransformFor = [],
  federationOptions,
}: AddEntryOptions): Plugin[] => {
  const DEV_HTML_PROXY_PREFIX = 'virtual:mf-html-entry-proxy?';
  const ENTRY_BOOTSTRAP_PARAM = 'mf-entry-bootstrap';
  const ENTRY_BOOTSTRAP_QUERY = `?${ENTRY_BOOTSTRAP_PARAM}`;
  const waitsForInit = entryName === 'hostInit';
  const getEntryPath = () => (typeof entryPath === 'function' ? entryPath() : entryPath);
  let devEntryPath = '';
  let entryFiles: string[] = [];
  let htmlFilePath: string | undefined;
  let _command: string;
  let emitFileId: string;
  let viteConfig: ResolvedConfig;
  // Producer remotes are consumed via federation entry URLs, not their index.html.
  // Skip only the broad dev HTML fallback — not isHydrationEntryFallback, which
  // SSR producer apps without index.html still need when hostInitInjectLocation is 'entry'.
  let skipHtmlDevFallback = forceClientInjected ?? false;
  let clientInjected = false;
  let emittedFileName: string | undefined;
  let skipTransformIds = new Set<string>();
  let injectedTransformIds = new Set<string>();
  const ignoredHtmlScriptSources = new Set<string>();
  let bootstrapDir = '';

  function skipSvelteKitSsrBuild() {
    return (
      (_command === 'build' || viteConfig?.command === 'build') &&
      viteConfig?.build?.ssr &&
      hasPackageDependency('@sveltejs/kit')
    );
  }

  function isSvelteKitServerModule(id: string) {
    return (
      hasPackageDependency('@sveltejs/kit') &&
      (id.includes('.svelte-kit/generated/') || id.includes('/@sveltejs/kit/src/runtime/server/'))
    );
  }

  function hasEntryBootstrapParam(id: string) {
    return (
      id.includes(ENTRY_BOOTSTRAP_PARAM) || decodeURIComponent(id).includes(ENTRY_BOOTSTRAP_PARAM)
    );
  }

  function rewriteSvelteKitInlineStart(html: string, initPath: string) {
    return html.replace(/<script>([\s\S]*?)<\/script>/gi, (scriptTag, body) => {
      if (!body.includes('kit.start(app, element);') || !body.includes('Promise.all([')) {
        return scriptTag;
      }
      // generateBundle and closeBundle both patch SvelteKit HTML; skip re-wrap.
      if (body.includes('initHost')) {
        return scriptTag;
      }

      const blockStart = body.indexOf('{');
      const blockEnd = body.lastIndexOf('}');
      if (blockStart === -1 || blockEnd <= blockStart) return scriptTag;

      const wrapped =
        body.slice(0, blockStart + 1) +
        `
const __mfCurrentScript = document.currentScript;
(async () => {
  await import(${JSON.stringify(initPath)}).then(({ initHost }) => initHost());
` +
        body
          .slice(blockStart + 1, blockEnd)
          .replaceAll('document.currentScript', '__mfCurrentScript') +
        `
})();
` +
        body.slice(blockEnd);

      return `<script>${wrapped}</script>`;
    });
  }

  function walkFiles(dir: string, predicate: (fileName: string) => boolean): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return walkFiles(entryPath, predicate);
      return entry.isFile() && predicate(entry.name) ? [entryPath] : [];
    });
  }

  function walkHtmlFiles(dir: string): string[] {
    return walkFiles(dir, (fileName) => fileName.endsWith('.html'));
  }

  function toRelativeImport(fromFile: string, targetFile: string) {
    const relative = normalizePathForImport(path.relative(path.dirname(fromFile), targetFile));
    return relative.startsWith('.') ? relative : `./${relative}`;
  }

  function patchSvelteKitStaticHtml() {
    const buildDir = path.resolve(viteConfig.root, 'build');
    let initFile = emittedFileName ? path.resolve(buildDir, emittedFileName) : undefined;
    if (!initFile || !fs.existsSync(initFile)) {
      initFile = walkFiles(buildDir, (fileName) => fileName.endsWith('.js')).find((file) => {
        const code = fs.readFileSync(file, 'utf-8');
        return code.includes('hostInitPromise') && code.includes('initHost');
      });
    }
    if (!initFile) return false;
    let patched = false;
    for (const htmlFile of walkHtmlFiles(buildDir)) {
      const html = fs.readFileSync(htmlFile, 'utf-8');
      const rewritten = rewriteSvelteKitInlineStart(html, toRelativeImport(htmlFile, initFile));
      if (rewritten !== html) {
        fs.writeFileSync(htmlFile, rewritten);
        patched = true;
      }
    }
    return patched;
  }

  // Absolute module-type remote entry URLs that are safe to warm before host
  // init runs. Used both by the bootstrap's runtime prefetch and as HTML
  // modulepreload hints, so the fetch starts at HTML parse time instead of
  // after the bootstrap script downloads and evaluates.
  function getRemoteEntryPreloadUrls(): string[] {
    const normalizedOptions = federationOptions ?? getNormalizeModuleFederationOptions();
    const isLoadedFirstClientBuild =
      (_command === 'build' || viteConfig?.command === 'build') &&
      waitsForInit &&
      !viteConfig?.build?.ssr &&
      normalizedOptions.shareStrategy === 'loaded-first';
    if (normalizedOptions.shareStrategy === 'loaded-first' && !isLoadedFirstClientBuild) return [];
    const remoteSources = isLoadedFirstClientBuild
      ? Array.from(getPreloadRemotes(normalizedOptions))
      : Object.entries(getUsedRemotesMap(federationOptions))
          .flatMap(([, remotes]) => Array.from(remotes))
          .filter(
            (remote) => !federationOptions || !isDynamicOnlyRemote(remote, federationOptions)
          );
    return Array.from(
      new Set(
        remoteSources.flatMap((remote) => {
          const registration = getRemoteRegistration(
            remote,
            normalizedOptions.remotes,
            federationOptions
          );
          return registration &&
            (registration.type === 'module' || registration.type === 'esm') &&
            /^(?:https?:)?\/\//.test(registration.entry)
            ? [registration.entry]
            : [];
        })
      )
    );
  }

  function getBootstrapSource(
    initSrc: string,
    entrySrc: string,
    useSystemImportFallback = false,
    options?: { skipRemotePreload?: boolean }
  ) {
    const importHelper = useSystemImportFallback
      ? `const __mfImport = (src) =>
  globalThis.System && typeof globalThis.System.import === 'function'
    ? globalThis.System.import(src)
    : import(src);
`
      : '';
    const importExpression = (src: string) =>
      useSystemImportFallback
        ? `__mfImport(${JSON.stringify(src)})`
        : `import(${JSON.stringify(src)})`;
    // Vite resolves literal dynamic imports during transform. An encoded virtual
    // module URL is already browser-resolvable through Vite's dev server, but
    // it is not resolvable relative to this in-memory proxy module. Preserve it
    // for the browser instead of asking Vite to resolve it a second time.
    const isEncodedVirtualEntry = entrySrc.startsWith(VITE_ENCODED_NULL_BYTE_PREFIX);
    const entryImportDeclaration = isEncodedVirtualEntry
      ? `const __mfEntryUrl = ${JSON.stringify(entrySrc)};
`
      : '';
    const entryImportExpression = isEncodedVirtualEntry
      ? 'import(/* @vite-ignore */ __mfEntryUrl)'
      : importExpression(entrySrc);

    const normalizedOptions = federationOptions ?? getNormalizeModuleFederationOptions();
    const isLoadedFirstClientBuild =
      (_command === 'build' || viteConfig?.command === 'build') &&
      waitsForInit &&
      !viteConfig?.build?.ssr &&
      normalizedOptions.shareStrategy === 'loaded-first';

    // `version-first` eagerly loads every used remote, while `loaded-first`
    // normally defers loading until an export is read. A static ESM import is
    // different: its namespace must be ready before the importing entry is
    // evaluated. Preload only those statically imported remotes in the client
    // production host bootstrap so dynamic-only remotes remain on-demand.
    const shouldPreloadRemotes =
      !options?.skipRemotePreload &&
      (normalizedOptions.shareStrategy !== 'loaded-first' || isLoadedFirstClientBuild);

    const remoteSources = isLoadedFirstClientBuild
      ? Array.from(getPreloadRemotes(normalizedOptions))
      : Object.entries(getUsedRemotesMap(federationOptions))
          .flatMap(([, remotes]) => Array.from(remotes))
          .filter(
            (remote) => !federationOptions || !isDynamicOnlyRemote(remote, federationOptions)
          );

    // Bare ids may represent a root (`.`) expose, so preload them too. Failures
    // remain non-blocking for version-first through Promise.allSettled below.
    const remotePreloads = shouldPreloadRemotes
      ? remoteSources
          .sort()
          .map((remote) => {
            const registration = isLoadedFirstClientBuild
              ? getRemoteRegistration(remote, normalizedOptions.remotes, federationOptions)
              : undefined;
            return `__mfPreloadRemote(${JSON.stringify(
              getRuntimeRemoteId(remote, normalizedOptions.remotes, federationOptions)
            )}, ${JSON.stringify(remote)}${
              registration ? `, ${JSON.stringify(registration)}` : ''
            })`;
          })
          .join(',')
      : '';

    // The remote entry fetch is independent of host init, but loadRemote() only
    // runs after `await initHost()` finishes its shared preloads, so remote
    // entries otherwise queue behind every shared chunk (staircase waterfall).
    // Warm the module-type entry URLs up front: the browser dedupes the
    // later loadRemote() import of the same URL against the in-flight request.
    const remoteEntryPrefetchUrls = shouldPreloadRemotes ? getRemoteEntryPreloadUrls() : [];
    const remoteEntryPrefetchBlock =
      remoteEntryPrefetchUrls.length > 0
        ? `const __mfRemoteEntryPrefetchUrls = ${JSON.stringify(remoteEntryPrefetchUrls)};
for (const __mfRemoteEntryPrefetchUrl of __mfRemoteEntryPrefetchUrls) {
  import(/* @vite-ignore */ __mfRemoteEntryPrefetchUrl).catch(() => {});
}
`
        : '';

    const sharedPreloadSources =
      _command === 'serve' &&
      waitsForInit &&
      Object.keys(normalizedOptions.exposes || {}).length > 0 &&
      Object.keys(normalizedOptions.remotes || {}).length === 0 &&
      federationOptions
        ? Array.from(getUsedShares(federationOptions))
            .filter((pkg) => !pkg.endsWith('/'))
            .filter((pkg) => {
              const shareItem =
                federationOptions.shared[pkg] ||
                Object.entries(federationOptions.shared).find(
                  ([key]) => key.endsWith('/') && pkg.startsWith(key)
                )?.[1];
              const isExplicitShare = Object.prototype.hasOwnProperty.call(
                federationOptions.shared,
                pkg
              );
              return (
                shareItem?.shareConfig?.singleton === true &&
                shareItem?.shareConfig?.import !== false &&
                !shareItem?.shareConfig?.treeShaking &&
                (isExplicitShare ||
                  typeof shareItem?.shareConfig?.import === 'string' ||
                  Boolean(getProjectResolvedImportPath(pkg)))
              );
            })
            .map((pkg) => toViteEncodedId(getLoadShareModulePath(pkg, false, federationOptions)))
        : [];
    const sharedPreloadBlock =
      sharedPreloadSources.length > 0
        ? `
  const __mfSharedPreloadUrls = ${JSON.stringify(sharedPreloadSources)};
  await Promise.all(__mfSharedPreloadUrls.map((src) => import(/* @vite-ignore */ src).catch((err) => console.warn("[module-federation] shared preload failed:", src, err))));`
        : '';
    const remoteCachePrefix = getRuntimeRemoteCachePrefix(federationOptions);
    const preloadRegistrationParameter = isLoadedFirstClientBuild ? ', registration' : '';
    const preloadRegistrationBlock = isLoadedFirstClientBuild
      ? `if (registration && typeof runtime.registerRemotes === "function") {
      runtime.registerRemotes([registration]);
    }`
      : '';

    const preloadBlock = remotePreloads
      ? `
  const runtime = await initHost();
  const __mfPreloadRemote = (runtimeRemote, remote${preloadRegistrationParameter}) => {
    ${preloadRegistrationBlock}
    const remoteCacheKey = ${JSON.stringify(remoteCachePrefix)} + remote;
    const pendingKey = "__mf_pending__" + remoteCacheKey;
    if (!__mfModuleCache.remote[pendingKey]) {
      __mfModuleCache.remote[pendingKey] = runtime.loadRemote(runtimeRemote)
        .then((mod) => {
          __mfModuleCache.remote[remoteCacheKey] = mod;
          delete __mfModuleCache.remote[pendingKey];
          return mod;
        })
        .catch((error) => {
          delete __mfModuleCache.remote[pendingKey];
          throw error;
        });
    }
    return __mfModuleCache.remote[pendingKey];
  };
  const __mfRemotePreloads = [${remotePreloads}];
  await ${isLoadedFirstClientBuild ? 'Promise.all' : 'Promise.allSettled'}(__mfRemotePreloads);`
      : `await initHost();`;

    // The hostInit chunk's top-level await may be lowered to an emulated
    // `__tla` promise (e.g. by vite-plugin-top-level-await, or any build target
    // below es2022). Under that lowering the dynamic import resolves after the
    // module's *synchronous* evaluation — before its async init assigns
    // `initHost` — so destructuring `initHost` immediately races the init and
    // reads `undefined` in engines that settle the import microtask first
    // (notably Safari/JavaScriptCore; V8 happens to win the race). Await the
    // module's exported `__tla` promise before reading `initHost`. No-op under
    // native TLA, where `__tla` is undefined.
    // After initHost, also await any pending share loads queued by loadShare
    // modules during init(). When init() seeds the cache with the loadShare
    // module's _exports (getters returning undefined), the loadShare module
    // defers real value assignment to an initPromise.then() + ESM import
    // callback. Those promises are tracked in __mfModuleCache.pendingShareLoads
    // so the bootstrap can await them before importing the entry, preventing
    // a race where the entry renders before the ESM import resolves.
    const pendingShareLoadsAwait = `
  if (__mfModuleCache.pendingShareLoads) {
    await Promise.all(__mfModuleCache.pendingShareLoads);
  }
  const __mfReactServerModuleCache = globalThis[${JSON.stringify(getModuleCacheGlobalKey(['react-server']))}];
  if (__mfReactServerModuleCache?.pendingShareLoads) {
    await Promise.all(__mfReactServerModuleCache.pendingShareLoads);
  }`;

    const importCode = `
(async () => {
  const __mfHostInit = await ${importExpression(initSrc)};
  await __mfHostInit.__tla;
  const { initHost } = __mfHostInit;
  ${preloadBlock}${sharedPreloadBlock}${pendingShareLoadsAwait}
})().then(() => ${entryImportExpression});
`;

    return [
      getRuntimeModuleCacheBootstrapCode(),
      importHelper,
      entryImportDeclaration,
      remoteEntryPrefetchBlock,
      importCode,
    ].join('\n');
  }

  function getSystemBootstrapSource(initSrc: string, entrySrc: string) {
    return getBootstrapSource(initSrc, entrySrc, true);
  }

  function injectHtml() {
    return inject === 'html' && (htmlFilePath || hasPackageDependency('@sveltejs/kit'));
  }

  function injectEntry() {
    if (inject === 'html' && hasPackageDependency('@sveltejs/kit')) return false;
    return inject === 'entry' || !htmlFilePath;
  }

  function normalizeDevHtmlProxyId(id: string) {
    return decodeViteId(id).replace(/^\0/, '');
  }

  function normalizeModuleId(id: string) {
    return normalizePathForImport(id.split('?')[0]);
  }

  function isReactRouterClientEntry(id: string) {
    const normalized = normalizeModuleId(decodeViteId(id).replace(/^\0+/, ''));
    return /(?:^|\/)entry\.client\.(?:[cm]?[jt]sx?)$/.test(normalized);
  }

  function resolveProjectId(id: string) {
    if (id.startsWith('\0') || id.startsWith('virtual:')) return normalizeModuleId(id);
    return normalizeModuleId(path.isAbsolute(id) ? id : path.resolve(viteConfig.root, id));
  }

  function isFederationInternalVirtualId(id: string) {
    const normalized = decodeViteId(id).replace(/^\0+/, '');
    return (
      normalized.includes('virtual:mf:') || /__(?:loadShare|prebuild|loadRemote)__/.test(normalized)
    );
  }

  function isWorkspaceSourceId(id: string) {
    const decoded = decodeViteId(id);
    const normalized = normalizeModuleId(decoded);
    if (normalized.startsWith('\0') || normalized.startsWith('virtual:')) return false;

    const filePath = stripQueryAndHash(normalized);
    // /@fs/ is Vite's own marker for "this id is a real filesystem path", so unlike
    // the branch below it needs no existsSync check — a virtual/framework id would
    // never carry this prefix in the first place.
    if (filePath.startsWith('/@fs/')) return true;
    if (!path.isAbsolute(filePath)) return false;

    const root = normalizePathForImport(path.resolve(viteConfig.root));
    const absolutePath = normalizePathForImport(path.resolve(filePath));
    const relativePath = normalizePathForImport(path.relative(root, absolutePath));
    const isOutsideRoot =
      relativePath === '..' || relativePath.startsWith('../') || path.isAbsolute(relativePath);

    // Vite transform IDs for workspace imports are absolute paths. Only classify
    // existing files outside the app root so virtual/framework IDs remain eligible
    // for the SSR hydration fallback.
    return isOutsideRoot && fs.existsSync(absolutePath);
  }

  function addEntryFile(file: string) {
    const normalized = normalizeModuleId(file);
    if (!entryFiles.includes(normalized)) entryFiles.push(normalized);
  }

  function addHtmlScriptEntries(htmlPath: string) {
    if (!fs.existsSync(htmlPath)) return;
    const htmlContent = fs.readFileSync(htmlPath, 'utf-8');
    const scriptRegex =
      /<script\b(?=[^>]*\btype=["']module["'])(?=[^>]*\bsrc=["']([^"']+)["'])[^>]*>/gi;
    let match: RegExpExecArray | null;

    while ((match = scriptRegex.exec(htmlContent)) !== null) {
      if (/\svite-ignore(?:\s|=|\/?>)/i.test(match[0])) {
        ignoredHtmlScriptSources.add(match[1]);
        continue;
      }
      const scriptSrc = stripQueryAndHash(match[1]);
      if (/^(?:[a-z]+:)?\/\//i.test(scriptSrc)) continue;
      addEntryFile(scriptSrc);
      const scriptPath = scriptSrc.startsWith('/')
        ? path.resolve(viteConfig.root, scriptSrc.slice(1))
        : path.resolve(path.dirname(htmlPath), scriptSrc);
      addEntryFile(scriptPath);
    }
  }

  function addEntryRemoteImports(entrySrc: string) {
    if (!federationOptions || /^(?:[a-z]+:)?\/\//i.test(entrySrc)) return;
    const file = path.resolve(viteConfig.root, stripQueryAndHash(entrySrc).replace(/^\//, ''));
    if (!fs.existsSync(file)) return;
    const code = fs.readFileSync(file, 'utf-8');
    for (const source of findModuleImportSources(code)) {
      const remote = Object.keys(federationOptions.remotes).find(
        (name) => source === name || source.startsWith(`${name}/`)
      );
      if (remote) {
        addUsedRemote(remote, source, federationOptions);
      }
    }
  }

  return [
    {
      name: 'add-entry',
      apply: 'serve',
      config(_config, { command }) {
        _command = command;
      },
      configResolved(config) {
        viteConfig = config;
        const resolvedEntryPath = getEntryPath();
        if (resolvedEntryPath.startsWith('virtual:mf')) {
          devEntryPath = config.base + VITE_ID_PREFIX.slice(1) + resolvedEntryPath;
        } else {
          // Convert absolute filesystem path to root-relative URL path.
          // On Windows, naive drive-letter stripping leaves the full directory
          // tree in the URL (e.g. /Repositories/.../node_modules/...) causing 404s.
          // Instead, compute the path relative to Vite's project root.
          const normalized = normalizePathForImport(resolvedEntryPath);
          const root = normalizePathForImport(config.root).replace(/\/$/, '');
          const relativePath = normalized.startsWith(root + '/')
            ? normalized.slice(root.length)
            : '/' + normalized.replace(/^[A-Za-z]:[\\/]/, '');
          devEntryPath = config.base + relativePath.replace(/^\//, '');
        }
        skipTransformIds = new Set(skipTransformFor.map(resolveProjectId));
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const rawUrl = req.url?.split('#')[0] ?? '';
          const proxyId = normalizeDevHtmlProxyId(rawUrl.split('?')[0]);
          if (proxyId === DEV_HTML_PROXY_PREFIX.slice(0, -1)) {
            const query = rawUrl.slice(rawUrl.indexOf('?') + 1);
            const params = new URLSearchParams(query);
            const initSrc = params.get('init');
            const entrySrc = params.get('entry');
            if (initSrc && entrySrc) {
              const withBase = (src: string) => viteConfig.base + src.replace(/^\//, '');
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/javascript');
              res.end(getBootstrapSource(withBase(initSrc), withBase(entrySrc)));
              return;
            }
          }
          if (!fileName) {
            next();
            return;
          }
          const devFileName = resolveDevHashEntryFileName(fileName);
          if (
            devFileName !== fileName &&
            req.url?.startsWith((viteConfig.base + devFileName).replace(/^\/?/, '/'))
          ) {
            req.url = req.url.replace(devFileName, fileName);
          }
          if (req.url && req.url.startsWith((viteConfig.base + fileName).replace(/^\/?/, '/'))) {
            req.url = devEntryPath;
            req.headers['sec-fetch-dest'] = 'script';
          }
          next();
        });
      },
      transformIndexHtml: {
        // Run before Vite's devHtmlHook so we see the original HTML.
        // devHtmlHook converts inline <script type="module"> tags into
        // external proxy modules; if we ran after it, rewriteEntryScripts
        // would mistakenly rewrite those proxied inline scripts too (#571).
        order: 'pre',
        handler(c) {
          const shouldWrapEntryHtml = _command === 'serve' && inject === 'entry' && waitsForInit;
          if (!injectHtml() && !shouldWrapEntryHtml) return;
          clientInjected = true;
          // Normalize all paths to root-relative (without base) before storing
          // in query params. devHtmlHook runs after pre hooks and prepends base
          // to script src attributes automatically, and Vite's server-side import
          // resolver also handles base — so query params must be base-free.
          // Note: originalSrc may or may not include the base depending on the
          // user's HTML (#590), so we normalize both directions uniformly.
          const base = viteConfig.base.replace(/\/$/, '');
          const stripBase = (p: string) =>
            base && p.startsWith(base + '/') ? p.slice(base.length) : p;
          const html = rewriteEntryScripts(c, (originalSrc) => {
            const entrySrc = stripBase(originalSrc);
            addEntryRemoteImports(entrySrc);
            // `virtual:` is a Vite plugin identifier, not a browser-supported
            // URL scheme. The bootstrap runs in the browser, so route virtual
            // entries through Vite's encoded module URL before dynamic import.
            const resolvedEntrySrc = entrySrc.startsWith('virtual:')
              ? toViteEncodedId(entrySrc)
              : entrySrc;
            const query = new URLSearchParams({
              init: sanitizeDevEntryPath(stripBase(devEntryPath)),
              entry: sanitizeDevEntryPath(resolvedEntrySrc),
            }).toString();
            return toViteEncodedId(`${DEV_HTML_PROXY_PREFIX}${query}`);
          });
          return html === c ? injectEntryScript(c, stripBase(devEntryPath)) : html;
        },
      },
      resolveId(id) {
        const normalizedId = normalizeDevHtmlProxyId(id);
        if (normalizedId.startsWith(DEV_HTML_PROXY_PREFIX)) {
          return id;
        }
      },
      load(id) {
        const normalizedId = normalizeDevHtmlProxyId(id);
        if (!normalizedId.startsWith(DEV_HTML_PROXY_PREFIX)) return;
        const params = new URLSearchParams(normalizedId.slice(DEV_HTML_PROXY_PREFIX.length));
        const initSrc = params.get('init');
        const entrySrc = params.get('entry');
        if (!initSrc || !entrySrc) return;
        return getBootstrapSource(initSrc, entrySrc);
      },
      transform(code, id) {
        if (id.includes('node_modules') || inject !== 'html' || htmlFilePath) {
          return;
        }

        if (id.includes('.svelte-kit') && id.includes('internal.js')) {
          return code.replace(
            /<head>/g,
            '<head><script type=\\"module\\" src=\\"' +
              sanitizeDevEntryPath(devEntryPath) +
              '\\"></script>'
          );
        }
      },
    },
    {
      name: 'add-entry',
      enforce: 'post',
      // In Vite 8 multi-environment setups (e.g. TanStack Start via Vinxi),
      // each environment has its own plugin pipeline. Without applyToEnvironment,
      // this plugin only runs in the default environment and the transform hook
      // never fires for modules in the client or ssr environments. Returning
      // true makes this plugin active in all environments so the transform (and
      // therefore bootstrap injection) fires wherever the client entry is processed.
      applyToEnvironment() {
        return true;
      },
      config(config) {
        patchHashEntryFileNames(config, entryName, fileName);
      },
      configResolved(config) {
        viteConfig = config;
        skipTransformIds = new Set(skipTransformFor.map(resolveProjectId));

        // In Vite 8 multi-environment mode this hook fires once per environment.
        // Only populate entryFiles from the 'client' environment — reading it from
        // 'ssr' would overwrite entryFiles with the server input (e.g. Nitro's
        // SSR entry) and break client injection detection for frameworks like
        // TanStack Start that set rollupOptions.input per-environment.
        // `this.environment` is Vite 8+ only. In Vite 5–7, `this` may be
        // undefined/null in strict mode, so guard before property access.
        const ctx = this as unknown;
        const envName = (
          ctx != null && typeof ctx === 'object'
            ? (ctx as Record<string, unknown>)['environment']
            : undefined
        ) as { name?: string } | undefined;
        if (envName?.name && envName.name !== 'client') return;
        const inputOptions = getBuildInput(config);

        if (!inputOptions) {
          htmlFilePath = path.resolve(config.root, 'index.html');
        } else if (typeof inputOptions === 'string') {
          entryFiles = [resolveProjectId(inputOptions)];
        } else if (Array.isArray(inputOptions)) {
          entryFiles = inputOptions
            // React Router framework mode exposes route modules as bundler
            // inputs so it can preserve their exports. They are code-split
            // routes, not browser bootstrap entries, and wrapping them leaks
            // server-only route code into client requests (#976).
            .filter((input) => !isReactRouterClientRouteInput(String(input)))
            .map(resolveProjectId);
        } else if (typeof inputOptions === 'object') {
          entryFiles = Object.values(inputOptions)
            .filter((input) => !isReactRouterClientRouteInput(String(input)))
            .map((input) => resolveProjectId(String(input)));
        }

        if (entryFiles.length > 0) {
          htmlFilePath = getFirstHtmlEntryFile(entryFiles);
        }

        // `build.rollupOptions.input` is a build-only concept, but it is also
        // what the branches above use to pick the dev-time HTML entry. Some
        // configs point it at a non-HTML build target that differs from what
        // the dev server actually serves -- e.g. a remote-only container
        // whose input is its exposed module, not an HTML page, or a
        // framework that sets a per-environment client entry. `vite dev`
        // still serves a root index.html directly in these cases, so fall
        // back to it here: without this, htmlFilePath stays unset,
        // transformIndexHtml's injectHtml() gate never opens, and the
        // host-init bootstrap (including the shared-singleton seeding pass
        // it performs before the entry evaluates) is never injected into the
        // page the browser loads. Serve-only: a build whose input omits
        // index.html never emits that file into the bundle either, so
        // generateBundle's own htmlFileNames check already makes this a
        // no-op for build.
        if (config.command === 'serve' && !htmlFilePath) {
          const rootIndexHtml = path.resolve(config.root, 'index.html');
          if (fs.existsSync(rootIndexHtml)) {
            htmlFilePath = rootIndexHtml;
          }
        }

        if (htmlFilePath) {
          addHtmlScriptEntries(htmlFilePath);
        }
      },
      buildStart() {
        if (_command === 'serve') return;
        if (skipSvelteKitSsrBuild()) return;
        // Skip Nitro's "ssr" environment — it reads all emitted entry chunks to
        // detect the SSR request handler, and picks up hostInit / remoteEntry
        // instead of the real framework SSR entry, causing
        // "mod.fetch is not a function". Other SSR environments (e.g. Vinext's
        // RSC environments) must still emit their entry chunks normally.
        const environmentName = (this as { environment?: { name?: string } }).environment?.name;
        if (environmentName === 'ssr') return;
        const hasHash = fileName?.includes?.('[hash');
        const emitFileOptions: any = {
          name: entryName,
          type: 'chunk',
          id: getEntryPath(),
          preserveSignature: 'strict',
        };
        if (!hasHash) {
          emitFileOptions.fileName = fileName;
        }
        emitFileId = this.emitFile(emitFileOptions);
        if (htmlFilePath) {
          addHtmlScriptEntries(htmlFilePath);
        }
      },
      generateBundle(_options, bundle) {
        if (skipSvelteKitSsrBuild()) return;
        if (
          entryName === 'remoteEntry' &&
          emitFileId &&
          fileName &&
          !viteConfig?.build?.ssr &&
          (_options as { format?: string })?.format === 'es' &&
          viteConfig?.build?.modulePreload !== false
        ) {
          // Not this.getFileName(emitFileId): with several federation configs
          // in one build, rolldown dedupes the emitted-chunk refs (all named
          // 'remoteEntry') and every instance would resolve to the last
          // config's file. The configured filename identifies this instance.
          const remoteEntryFile = findRemoteEntryFile(fileName, bundle);
          if (remoteEntryFile) {
            appendRemoteEntryWarmup(bundle, remoteEntryFile);
          }
        }
        if (!injectHtml()) return;
        if (!emitFileId) return;
        const htmlFileNames = Object.keys(bundle).filter((fileName) => fileName.endsWith('.html'));
        if (htmlFileNames.length === 0) return;
        const file = this.getFileName(emitFileId);
        emittedFileName = file;
        // Derive bootstrapDir from the emitted hostInit file path.
        // entryFileNames is normalized away by Vite/Rolldown before plugins
        // can read it, so we extract the directory from the actual output path.
        const lastSlash = file.lastIndexOf('/');
        bootstrapDir = lastSlash !== -1 ? file.slice(0, lastSlash + 1) : '';
        // Helper to resolve path with proper renderBuiltUrl handling
        const resolvePath = (builtFileName: string, htmlFileName: string): string => {
          if (!viteConfig.experimental?.renderBuiltUrl) {
            return viteConfig.base + builtFileName;
          }

          const result = viteConfig.experimental.renderBuiltUrl(builtFileName, {
            hostId: htmlFileName,
            hostType: 'html',
            type: 'asset',
            ssr: false,
          });

          // Handle return types
          if (typeof result === 'string') {
            return result;
          }

          if (result && typeof result === 'object') {
            if ('runtime' in result) {
              // Runtime code cannot be used in <script src="">
              mfWarn(
                'renderBuiltUrl returned runtime code for HTML injection. ' +
                  'Runtime code cannot be used in <script src="">. Falling back to base path.'
              );
              return viteConfig.base + builtFileName;
            }
            if (result.relative) {
              return builtFileName;
            }
          }

          // Fallback for undefined or unexpected values
          return viteConfig.base + builtFileName;
        };

        // Strip Vite base before rebasing — paths in HTML include the base
        // prefix (e.g. "/app/static/js/hostInit.js" with base="/app/"),
        // but rebaseImport works against the output directory structure
        // (e.g. "static/js/"), which is relative to the build root.
        const basePrefix = viteConfig.base?.replace(/\/$/, '') ?? '';
        const stripBase = (p: string) =>
          basePrefix && p.startsWith(basePrefix + '/') ? p.slice(basePrefix.length) : p;

        let bootstrapIndex = 0;
        // Process each HTML file
        for (const fileName of htmlFileNames) {
          let htmlAsset = bundle[fileName];
          if (htmlAsset.type === 'chunk') return;

          let htmlContent = htmlAsset.source.toString() || '';
          const initPath = resolvePath(file, fileName);
          const scriptRegex =
            /<script\b(?=[^>]*\btype=["']module["'])(?=[^>]*\bsrc=["']([^"']+)["'])[^>]*>\s*<\/script>/gi;
          let rewritten = false;
          htmlContent = htmlContent.replace(scriptRegex, (scriptTag, entrySrc) => {
            if (ignoredHtmlScriptSources.has(entrySrc)) return scriptTag;
            rewritten = true;
            const strippedInit = stripBase(initPath);
            const strippedEntry = stripBase(entrySrc);
            const rebasedInitPath = bootstrapDir
              ? rebaseImport(strippedInit, bootstrapDir)
              : initPath;
            const rebasedEntrySrc = bootstrapDir
              ? rebaseImport(strippedEntry, bootstrapDir)
              : entrySrc;
            const bootstrapSource = getSystemBootstrapSource(rebasedInitPath, rebasedEntrySrc);
            // Content-hash the bootstrap filename so browsers/CDNs invalidate
            // the cache on deploy. Without a hash the file ships as
            // `mf-entry-bootstrap-0.js` and stale caches serve the old
            // bootstrap, breaking app load after a deploy.
            const bootstrapHash = createHash('sha256')
              .update(bootstrapSource)
              .digest('hex')
              .slice(0, 8);
            const bootstrapFileName = `${bootstrapDir}mf-entry-bootstrap-${bootstrapIndex++}-${bootstrapHash}.js`;
            const bootstrapRef = this.emitFile({
              type: 'asset',
              fileName: bootstrapFileName,
              source: bootstrapSource,
            });
            const bootstrapPath = viteConfig.base + this.getFileName(bootstrapRef);
            return scriptTag.replace(entrySrc, bootstrapPath);
          });

          if (!rewritten) {
            const svelteKitHtml = rewriteSvelteKitInlineStart(htmlContent, initPath);
            if (svelteKitHtml !== htmlContent) {
              htmlContent = svelteKitHtml;
            } else {
              const scriptContent = `
          <script type="module" src="${initPath}"></script>
        `;
              htmlContent = htmlContent.replace('<head>', `<head>${scriptContent}`);
            }
          }
          if (waitsForInit && viteConfig.build.modulePreload !== false) {
            htmlContent = injectHostInitPreloads(
              htmlContent,
              bundle,
              (builtFileName) => resolvePath(builtFileName, fileName),
              getRemoteEntryPreloadUrls()
            );
          }
          htmlAsset.source = htmlContent;
        }
      },
      closeBundle() {
        if (
          _command === 'serve' ||
          !hasPackageDependency('@sveltejs/kit') ||
          skipSvelteKitSsrBuild()
        ) {
          return;
        }

        let attempts = 0;
        const retry = () => {
          attempts += 1;
          if (!patchSvelteKitStaticHtml() && attempts < 20) setTimeout(retry, 50);
        };
        setTimeout(retry, 0);
      },
      transform(code, id) {
        if (skipSvelteKitSsrBuild()) return;
        if (isSvelteKitServerModule(id)) return;
        if (hasEntryBootstrapParam(id)) return;
        if (normalizeModuleId(id).endsWith('.html')) return;
        const projectId = resolveProjectId(id);
        if (skipTransformIds.has(projectId)) return;
        // Only inject into client-side modules. In Vite 8 multi-environment mode
        // this transform also runs for ssr/server environments — injecting there
        // would set clientInjected=true and prevent the real client injection.
        const transformCtx = this as unknown;
        const transformEnv = (
          transformCtx != null && typeof transformCtx === 'object'
            ? (transformCtx as Record<string, unknown>)['environment']
            : undefined
        ) as { name?: string } | undefined;
        if (transformEnv?.name && transformEnv.name !== 'client') return;
        const isVinext = hasPackageDependency('vinext');
        if (
          isVinext &&
          inject === 'html' &&
          id.includes('virtual:vite-rsc/remove-duplicate-server-css')
        ) {
          const namespaceReactImport = `import * as React from 'react';`;
          if (code.includes(namespaceReactImport)) return;
          const rewritten = code.replace(
            /import\s+React\s+from\s+['"]react['"];?/,
            namespaceReactImport
          );
          return rewritten === code ? undefined : mapCodeToCodeWithSourcemap(rewritten);
        }

        if (
          isVinext &&
          inject === 'html' &&
          (id.includes('virtual:vite-rsc/entry-browser') ||
            id.includes('virtual:vinext-app-browser-entry'))
        ) {
          const injection = `import ${JSON.stringify(getEntryPath())};\n`;
          if (code.includes(injection.trim())) {
            clientInjected = true;
            return;
          }
          clientInjected = true;
          return mapCodeToCodeWithSourcemap(injection + code);
        }

        const isNuxtMountEntry =
          _command === 'serve' &&
          inject === 'entry' &&
          waitsForInit &&
          !clientInjected &&
          /(?:^|\/)nuxt\/dist\/app\/entry\.js(?:\?|$)/.test(id) &&
          code.includes('vueApp.mount(vueAppRootContainer);');
        if (isNuxtMountEntry) {
          clientInjected = true;
          const injection = `await import(${JSON.stringify(getEntryPath())}).then(({ initHost }) => initHost());\n      `;
          return mapCodeToCodeWithSourcemap(
            code.replace(
              'vueApp.mount(vueAppRootContainer);',
              `${injection}vueApp.mount(vueAppRootContainer);`
            )
          );
        }

        // SSR hosts without index.html (Nitro, TanStack Start) and
        // hostInitInjectLocation:'entry' have no rollup input in dev. Match the
        // client module that hydrates/mounts the app so host init runs before
        // hydrateRoot / app.mount — required for @module-federation/bridge-*
        // remotes that call getInstance() on first render. Covers React
        // (hydrateRoot / createRoot / ReactDOM.render) and Vue clients. Vue
        // entries frequently mount via `app.mount('#app')` while the
        // createApp/createSSRApp call lives in a separate module, so match a
        // selector-string mount on its own as well as a co-located createApp.
        const isReactRouterEntry = isReactRouterClientEntry(id);
        const isHydrationEntryFallback =
          inject === 'entry' &&
          entryFiles.length === 0 &&
          (!htmlFilePath || !fs.existsSync(htmlFilePath)) &&
          !clientInjected &&
          !isFederationInternalVirtualId(id) &&
          !id.includes('node_modules') &&
          (!code.includes('HydratedRouter') || isReactRouterEntry) &&
          (id.startsWith('\0') || /\.(js|ts|mjs|vue|jsx|tsx)(\?|$)/.test(id)) &&
          (/hydrateRoot|createRoot|ReactDOM\.render/.test(code) ||
            /\.mount\s*\(\s*['"#]/.test(code) ||
            (/\.mount\s*\(/.test(code) && /createSSRApp|createApp/.test(code))) &&
          // Cheapest-last: this can do a synchronous fs.existsSync, so only pay
          // for it once every other, cheaper candidacy check has already passed.
          !isWorkspaceSourceId(id);

        const isNuxtEntryAsyncModule =
          /(?:^|\/)nuxt\/dist\/app\/entry\.async\.js(?:\?|$)/.test(id) && code.includes('entry();');
        const isNuxtClientEntryFallback =
          _command === 'serve' &&
          inject === 'entry' &&
          (!htmlFilePath || !fs.existsSync(htmlFilePath)) &&
          !clientInjected &&
          !hasEntryBootstrapParam(id) &&
          !id.includes('node_modules/.vite') &&
          isNuxtEntryAsyncModule &&
          !entryFiles.some((file) => projectId === file);

        // Nuxt dev loads entry.async.js as the HTML module script; wrapping it in
        // the async host-init bootstrap sets clientInjected before entry.js is
        // processed, so the mount-time init injection never runs and Vue stays inert.
        const skipNuxtDevEntryAsyncInject = _command === 'serve' && isNuxtEntryAsyncModule;

        const shouldInject =
          !skipNuxtDevEntryAsyncInject &&
          (injectedTransformIds.has(projectId) ||
            (injectEntry() && entryFiles.some((file) => projectId === file)) ||
            // Fallback for SSR frameworks (e.g. Nuxt) that bypass transformIndexHtml.
            (_command === 'serve' &&
              inject === 'html' &&
              !isVinext &&
              !clientInjected &&
              !skipHtmlDevFallback &&
              !id.startsWith('\0') &&
              !id.includes('node_modules') &&
              /\.(js|ts|mjs|vue|jsx|tsx)(\?|$)/.test(id)) ||
            // Fallback for frameworks (e.g. TanStack Start) that manage their own
            // client entry and never populate rollupOptions.input in dev. Inject
            // into the module that mounts/hydrates the React app — identified by
            // the presence of hydrateRoot, createRoot, or ReactDOM.render calls.
            // TanStack Start inlines client.tsx into a virtual entry module, so
            // we also match virtual IDs (id.startsWith('\0')) that contain the
            // hydration call.
            isHydrationEntryFallback ||
            // React Router v8 hides its framework client entry from bundler
            // inputs. Match the documented entry filename in dev and build;
            // source matching can select an imported helper and erase exports.
            (inject === 'entry' && waitsForInit && isReactRouterEntry) ||
            isNuxtClientEntryFallback);
        if (shouldInject) {
          clientInjected = true;
          injectedTransformIds.add(projectId);
          // Non-hostInit injections only need a side-effect import. Host-init
          // bootstrap must await initHost() before the app entry runs — in both
          // build and serve — so bridge-react remotes do not hit
          // "Module Federation runtime is not initialized" on first paint.
          if (!waitsForInit) {
            const injection = `import ${JSON.stringify(getEntryPath())};\n`;
            return mapCodeToCodeWithSourcemap(injection + code);
          }
          const entrySrc = id.includes('?')
            ? `${id}&${ENTRY_BOOTSTRAP_QUERY.slice(1)}`
            : `${id}${ENTRY_BOOTSTRAP_QUERY}`;
          const bootstrap = getBootstrapSource(getEntryPath(), entrySrc, false, {
            skipRemotePreload: _command === 'serve' && isNuxtEntryAsyncModule,
          });
          return mapCodeToCodeWithSourcemap(bootstrap);
        }
      },
    },
  ];
};

export default addEntry;

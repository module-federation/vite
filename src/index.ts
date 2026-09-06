import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import * as path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'url';
import type {
  ConfigEnv,
  EnvironmentOptions,
  Plugin,
  ResolvedConfig,
  UserConfig,
  ViteDevServer,
} from 'vite';
import { version as viteVersion } from 'vite';
import addEntry, { getBuildInput } from './plugins/pluginAddEntry';
import { checkAliasConflicts } from './plugins/pluginCheckAliasConflicts';
import pluginDevRemoteHmr, { shouldIgnoreFile } from './plugins/pluginDevRemoteHmr';
import pluginExternalRuntimeCore from './plugins/pluginExternalRuntimeCore';
import pluginManifest from './plugins/pluginMFManifest';
import pluginModuleParseEnd, { createModuleParseController } from './plugins/pluginModuleParseEnd';
import pluginProxyRemoteEntry from './plugins/pluginProxyRemoteEntry';
import pluginProxyRemotes from './plugins/pluginProxyRemotes';
import {
  excludeSharedSubDependencies,
  findSharedKey,
  getSharedPackageFromFile,
  isSharedPackageDependency,
  proxySharedModule,
} from './plugins/pluginProxySharedModule_preBuild';
import { pluginRemoteNamedExports } from './plugins/pluginRemoteNamedExports';
import { pluginSSRRemoteEntry } from './plugins/pluginSSRRemoteEntry';
import pluginVarRemoteEntry from './plugins/pluginVarRemoteEntry';
import aliasToArrayPlugin from './utils/aliasToArrayPlugin';
import {
  collectLoadShareProxyChunks,
  collectSystemProxyInfos,
  rewriteEsmProxyConsumers,
  rewriteSystemProxyConsumers,
} from './utils/bundleHelpers';
import { normalizePathForImport } from './utils/buildPaths';
import {
  isFederationControlChunk,
  sanitizeFederationControlChunk,
} from './utils/controlChunkSanitizer';
import { isTestEnv } from './utils/isTestEnv';
import { createModuleFederationError, mfWarn } from './utils/logger';
import { getSharedExportConditions } from './utils/sharedExportConditions';
import type {
  ModuleFederationOptions,
  NormalizedModuleFederationOptions,
  PluginExperimentsOptions,
  PluginManifestOptions,
  ShareItem,
  TreeShakingConfig,
} from './utils/normalizeModuleFederationOptions';
import { normalizeModuleFederationOptions } from './utils/normalizeModuleFederationOptions';
import normalizeOptimizeDepsPlugin from './utils/normalizeOptimizeDeps';
import {
  getIsRolldown,
  getInstalledPackageEntry,
  getInstalledPackageJson,
  getPackageName,
  getPackageNameFromNodeModulePath,
  hasPackageDependency,
  resolveImportPath,
  setPackageDetectionCwd,
} from './utils/packageUtils';
import {
  applyRuntimeCapabilityDefines,
  getRuntimeCapabilityConfigurationWarnings,
} from './utils/runtimeCapabilityOptimization';
import { getSharedExportUsage } from './utils/treeShaking';
import {
  getSsrCapabilities,
  SSR_ENTRY_LOADER_SPECIFIER,
  SSR_ONLY_RUNTIME_PLUGINS,
} from './utils/ssrCapabilities';
import {
  getCommonSharedSubpaths,
  isAssetLikeImport,
  isViteOptimizableEntry,
} from './utils/pathNormalization';
import { findModuleImportDescriptors, getScannableModuleSource } from './utils/htmlEntryUtils';
import VirtualModule, { createViteEncodedIdPrefixRegExp } from './utils/VirtualModule';
import {
  getHostAutoInitPath,
  getPendingSharesPath,
  isOwnedPendingSharesId,
  PENDING_SHARES_TAG,
  refreshPendingShares,
  getRemoteEntryId,
  initVirtualModules,
  LOAD_REMOTE_TAG,
  LOAD_SHARE_TAG,
  PREBUILD_TAG,
  refreshRemoteModuleForEnvironment,
  TREE_SHAKING_GRAPH_QUERY,
  TREE_SHAKING_PROVIDER_TAG,
  writeLocalSharedImportMap,
} from './virtualModules';
import { getVirtualExposesId } from './virtualModules/virtualExposes';
import {
  addConfiguredShare,
  addUsedShares,
  HOST_AUTO_INIT_TAG,
  isOwnedHostAutoInitId,
  refreshHostAutoInit,
} from './virtualModules/virtualRemoteEntry';
import {
  addUsedRemote,
  markPreloadRemote,
  markStaticRemote,
} from './virtualModules/virtualRemotes';
import { getRuntimeInitStatusImportId } from './virtualModules/virtualRuntimeInitStatus';
import {
  findCurrentLoadShareForStaleOwnerId,
  getCachedLoadSharePkg,
  getCachedPreBuildPkg,
  getLoadShareModulePath,
  getPreBuildLibImportId,
  invalidateSharedExportInspectionCache,
  materializeCachedLoadShareModule,
  prependWorkspaceSingletonSsrImport,
  resetConcreteSharedImportSourceCache,
  writeLoadShareModule,
  writePreBuildLibPath,
} from './virtualModules/virtualShared_preBuild';

const patchedManualChunks = new WeakSet<Function>();
// Plugin-created codeSplitting groups, tracked by object identity so a user group
// that happens to share a federation group's name (e.g. `vite-preload-helper`)
// isn't mistaken for one of ours and dropped.
const federationGroups = new WeakSet<object>();

// Rolldown injects the `__vite_preload` helper as a special runtime module and,
// left to automatic chunking, hoists it into whichever loadShare chunk first uses
// it. When that shared singleton's source statically imports another shared
// singleton, the resulting cross-loadShare static import closes a top-level-await
// cycle and the host deadlocks on bootstrap. Isolate the helper into its own
// dependency-free, TLA-free chunk so no loadShare chunk imports it from a sibling.
const PRELOAD_HELPER_CHUNK = 'vite-preload-helper';
// Matches Rolldown's injected helper module id (`\0vite/preload-helper.js`).
// Anchored on the `vite/` segment so a user module merely named "preload-helper"
// isn't pulled into this chunk; the leading virtual-module NUL is optional.
const PRELOAD_HELPER_TEST = /\0?vite\/preload-helper/;

type CodeSplittingGroup = {
  name: string | ((id: string) => string | null);
  test?: RegExp;
  priority?: number;
};

// Federation groups must always outrank user-provided codeSplitting groups so a
// user group can never capture a runtimeInit/loadShare wrapper or the preload
// helper (Rolldown assigns each module to the highest-priority matching group).
// User group priorities are clamped below this value.
const MF_GROUP_PRIORITY = 1_000_000;
const USER_GROUP_MAX_PRIORITY = MF_GROUP_PRIORITY - 1;

type ViteWatchOptions = NonNullable<NonNullable<UserConfig['server']>['watch']>;
type ViteWatchConfig = ViteWatchOptions | boolean | null | undefined;

function normalizeVinextRscPreloadHints(code: string): string {
  return code
    .replace(/(:HL\[[^\]\n]*?,)"stylesheet"/g, '$1"style"')
    .replace(/(:HL\[[^\]\n]*?,)\\"stylesheet\\"/g, '$1\\"style\\"');
}

function ignoreFederationGeneratedFiles(
  config: UserConfig,
  options: NormalizedModuleFederationOptions
): void {
  config.server ??= {};
  const watch = config.server.watch as ViteWatchConfig;

  if (watch === false || watch === null) {
    return;
  }

  const watchOptions = watch === true || watch === undefined ? {} : watch;
  config.server.watch = watchOptions;

  const federationIgnore = (file: string) => shouldIgnoreFile(file, options);
  const ignored = watchOptions.ignored;
  if (!ignored) {
    watchOptions.ignored = federationIgnore;
    return;
  }
  if (Array.isArray(ignored)) {
    ignored.push(federationIgnore);
    return;
  }
  watchOptions.ignored = [ignored, federationIgnore];
}

function isSharedResolverInternalImporter(importer: string | undefined): boolean {
  return !!importer && (importer.includes(LOAD_SHARE_TAG) || importer.includes('__prebuild__'));
}

function isCommonJsImporter(importer: string | undefined): boolean {
  return !!importer && (importer.endsWith('.cjs') || importer.includes('/cjs/'));
}

function isReactDomSelfReference(source: string, importer: string | undefined): boolean {
  return source === 'react-dom' && getPackageNameFromNodeModulePath(importer ?? '') === 'react-dom';
}

type OutputNameOption = string | ((...args: unknown[]) => string);
type ManualChunksOption =
  | Record<string, string[]>
  | ((id: string, ...args: unknown[]) => string | void);
type OutputNameOptions = {
  entryFileNames?: OutputNameOption;
  chunkFileNames?: OutputNameOption;
  assetFileNames?: OutputNameOption;
};
type CodeSplittingOptions = { groups?: unknown } & Record<string, unknown>;
type MutableBundlerOutput = OutputNameOptions & {
  codeSplitting?: false | CodeSplittingOptions;
  manualChunks?: ManualChunksOption;
} & Record<string, unknown>;
type RolldownOptionsLike = { output?: MutableBundlerOutput | MutableBundlerOutput[] };
type EnvironmentWithRolldownOptions = {
  getRolldownOptions?: () => RolldownOptionsLike | Promise<RolldownOptionsLike>;
};
type BuilderLike = { environments: Record<string, EnvironmentWithRolldownOptions> };
type ModulePreloadResolveContext = { hostId: string; hostType: 'html' | 'js' };
type ResolveAliasEntry = { find: string | RegExp; replacement: string };
type BundleChunkLike = { type: 'chunk'; fileName: string; code: string };
type BundleAssetLike = { type: 'asset'; fileName: string };
type BundleLike = Record<string, BundleChunkLike | BundleAssetLike>;
type NormalizedOutputOptionsLike = { dir?: string };
type RenderedChunkLike = { fileName: string };

function isOutputChunk(chunk: BundleLike[string]): chunk is BundleChunkLike {
  return chunk.type === 'chunk';
}

function appendResolveAlias(config: UserConfig, alias: ResolveAliasEntry): void {
  const resolve = (config.resolve ??= {});
  const existingAlias = resolve.alias;
  if (!existingAlias) {
    resolve.alias = [alias];
    return;
  }
  if (Array.isArray(existingAlias)) {
    existingAlias.push(alias);
    return;
  }
  resolve.alias = [
    ...Object.entries(existingAlias).map(([find, replacement]) => ({ find, replacement })),
    alias,
  ];
}

function getRuntimeHelpersImplementation(runtimeImplementation: string): string {
  const indexEntryMatch = runtimeImplementation.match(/^(.*[\\/])index(\.[cm]?js)$/);
  if (indexEntryMatch) {
    return normalizePathForImport(`${indexEntryMatch[1]}helpers${indexEntryMatch[2]}`);
  }

  const extension = path.extname(runtimeImplementation);
  if (extension) {
    return normalizePathForImport(
      path.join(path.dirname(runtimeImplementation), `helpers${extension}`)
    );
  }

  if (path.isAbsolute(runtimeImplementation) || runtimeImplementation.startsWith('.')) {
    return normalizePathForImport(path.join(runtimeImplementation, 'helpers'));
  }

  return `${runtimeImplementation.replace(/\/$/, '')}/helpers`;
}

const UNSAFE_JS_SOURCE_CHAR_MAP: Record<string, string> = {
  '<': '\\u003C',
  '>': '\\u003E',
  '/': '\\u002F',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\0': '\\0',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

function escapeUnsafeJsSourceChars(str: string): string {
  return str.replace(/[<>/\\\b\f\n\r\t\0\u2028\u2029]/g, (char) => {
    return UNSAFE_JS_SOURCE_CHAR_MAP[char] ?? char;
  });
}

function isFederationHtmlPreloadDependency(dep: string, includeSharedRuntime = false): boolean {
  const file = path.basename(dep);
  if (
    file.includes('__mfe_internal__') ||
    file.includes('virtual_mf-') ||
    file.includes('virtualExposes') ||
    file.includes('localSharedImportMap') ||
    file.includes('hostInit')
  ) {
    return true;
  }

  return (
    includeSharedRuntime &&
    (file.includes('preload-helper') ||
      file.includes('rolldown-runtime') ||
      file.startsWith('dist-'))
  );
}

// Returns false for subpaths that either aren't exported by the installed
// package (e.g. react/compiler-runtime on React 18) or resolve to a file
// Vite's optimizer refuses to bundle (e.g. raw .tsx source), so callers can
// exclude them from Vite's dep optimizer instead of letting Vite silently
// drop them with a "Cannot optimize dependency" warning every dev start.
function canResolveSharedSubpath(subpath: string, projectRoot: string): boolean {
  try {
    const req = createRequire(pathToFileURL(path.join(projectRoot, 'package.json')));
    return isViteOptimizableEntry(req.resolve(subpath));
  } catch (error) {
    // An ESM-only package (an `exports` map with no CommonJS `require`/`default`
    // condition) makes Node's require.resolve throw ERR_PACKAGE_PATH_NOT_EXPORTED even
    // though Vite's own resolver can resolve it. Excluding such a package from dependency
    // optimization serves its raw CommonJS sub-dependencies to the browser in dev, which
    // blanks the app. Resolve its import target and let Vite pre-bundle it (and its
    // transitive CJS deps) with interop when the target is optimizable.
    //
    // Only apply this to a package's main entry (a bare specifier). A *subpath* can throw
    // the same code simply because it isn't exported at all (e.g. react/compiler-runtime
    // on React versions that predate it), which genuinely cannot be optimized and must
    // stay excluded. https://github.com/module-federation/vite/issues/974
    if (
      (error as NodeJS.ErrnoException)?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' &&
      !isBarePackageSubpath(subpath)
    ) {
      const entry = resolveViteImportPackageEntry(subpath, projectRoot);
      return entry !== undefined && existsSync(entry) && isViteOptimizableEntry(entry);
    }
    return false;
  }
}

const VITE_DEV_IMPORT_CONDITIONS = new Set([
  'browser',
  'development',
  'import',
  'module',
  'default',
]);

function resolveConditionalExportTarget(target: unknown): string | undefined {
  if (typeof target === 'string') return target;
  if (Array.isArray(target)) {
    for (const candidate of target) {
      const resolved = resolveConditionalExportTarget(candidate);
      if (resolved) return resolved;
    }
    return undefined;
  }
  if (!target || typeof target !== 'object') return undefined;

  for (const [condition, candidate] of Object.entries(target)) {
    if (!VITE_DEV_IMPORT_CONDITIONS.has(condition)) continue;
    const resolved = resolveConditionalExportTarget(candidate);
    if (resolved) return resolved;
  }
  return undefined;
}

function resolveViteImportPackageEntry(
  packageName: string,
  projectRoot: string
): string | undefined {
  const installed = getInstalledPackageJson(packageName, { cwd: projectRoot });
  if (!installed) return undefined;

  const exportsField = installed.packageJson.exports;
  let rootExport: unknown = exportsField;
  if (exportsField && typeof exportsField === 'object' && !Array.isArray(exportsField)) {
    const exportsRecord = exportsField as Record<string, unknown>;
    if (Object.keys(exportsRecord).some((key) => key.startsWith('.'))) {
      rootExport = exportsRecord['.'];
    }
  }

  const target = resolveConditionalExportTarget(rootExport);
  if (!target?.startsWith('./')) return undefined;
  const resolved = path.resolve(installed.dir, target);
  const relative = path.relative(installed.dir, resolved);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  return resolved;
}

// True when `specifier` addresses a subpath of a package (e.g. `react/compiler-runtime`)
// rather than its main entry (e.g. `react` or `@scope/pkg`).
function isBarePackageSubpath(specifier: string): boolean {
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.length > 2 : segments.length > 1;
}

/**
 * Vite's dependency scanner cannot see through the virtual loadShare modules
 * generated for shared packages. As a result, dependencies of a linked/shared
 * package may be discovered one request at a time and each discovery starts a
 * new optimizer pass. Seed the optimizer with the complete dependency graph
 * before the first request instead.
 *
 * Vite then resolves the package's own dependency graph using its normal
 * scanner, preserving package and peer-dependency resolution semantics.
 */
function includeLinkedSharedEntries(
  optimizeDeps: NonNullable<UserConfig['optimizeDeps']>,
  shared: NormalizedModuleFederationOptions['shared'],
  projectRoot: string,
  exposes: NormalizedModuleFederationOptions['exposes'],
  outDir: string
): void {
  const additions = new Set<string>();

  const entries = new Set(
    Array.isArray(optimizeDeps.entries)
      ? optimizeDeps.entries
      : optimizeDeps.entries
        ? [optimizeDeps.entries]
        : [
            '**/*.html',
            '!**/node_modules/**',
            `!**/${outDir.replace(/\\/g, '/')}/**`,
            '!**/__tests__/**',
            '!**/coverage/**',
          ]
  );

  for (const [packageName, share] of Object.entries(shared ?? {})) {
    if (share?.shareConfig?.import === false) continue;
    const configuredImport = share?.shareConfig?.import;
    if (typeof configuredImport === 'string') {
      const entry = path.isAbsolute(configuredImport)
        ? configuredImport
        : path.resolve(projectRoot, configuredImport);
      if (existsSync(entry) && !entry.replaceAll('\\', '/').includes('/node_modules/')) {
        additions.add(entry);
        continue;
      }
    }
    const installed = getInstalledPackageJson(packageName, { cwd: projectRoot });
    if (!installed || installed.dir.replaceAll('\\', '/').includes('/node_modules/')) continue;
    const entry = getInstalledPackageEntry(packageName, { cwd: projectRoot });
    if (entry && existsSync(entry)) additions.add(entry);
  }

  for (const expose of Object.values(exposes ?? {})) {
    const source = expose.import;
    if (source.startsWith('.') || path.isAbsolute(source)) {
      const entry = path.resolve(projectRoot, source);
      if (existsSync(entry)) additions.add(entry);
    }
  }

  if (additions.size === 0) return;

  for (const entry of additions) entries.add(entry);
  optimizeDeps.entries = [...entries];
}

function stabilizeOptimizeDeps(optimizeDeps: NonNullable<UserConfig['optimizeDeps']>): void {
  optimizeDeps.include = [...new Set(optimizeDeps.include ?? [])].sort();
  optimizeDeps.exclude = [...new Set(optimizeDeps.exclude ?? [])].sort();
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

// React Router's build plugin appends a synthetic `?__react-router-build-client-route`
// entry per route that isn't a real module on disk, so it must be excluded before this
// scan tries to read it as a source file.
function isReactRouterBuildClientRouteInput(entry: string): boolean {
  return /[?&]__react-router-build-client-route(?:[=&]|$)/.test(entry);
}

/**
 * Files whose JSX the compiler rewrites to an automatic-runtime import.
 * Vite only applies the JSX transform to these extensions by default.
 */
const JSX_SOURCE_EXTENSIONS = ['.jsx', '.tsx'];

type JsxTransformOptions = {
  jsx?: string | { runtime?: string; importSource?: string; development?: boolean };
  jsxImportSource?: string;
  jsxDev?: boolean;
};

function getAutomaticJsxRuntime(config: ResolvedConfig): string | undefined {
  for (const candidate of [config.oxc, config.esbuild]) {
    if (!candidate || typeof candidate !== 'object') continue;
    const transform = candidate as JsxTransformOptions;
    const jsx = transform.jsx;
    const runtime = typeof jsx === 'object' ? jsx.runtime : jsx;
    if (runtime && runtime !== 'automatic') return undefined;
    if (runtime !== 'automatic') continue;
    const importSource =
      (typeof jsx === 'object' ? jsx.importSource : undefined) ??
      transform.jsxImportSource ??
      'react';
    const development =
      (typeof jsx === 'object' ? jsx.development : undefined) ?? transform.jsxDev ?? true;
    return `${importSource}/${development ? 'jsx-dev-runtime' : 'jsx-runtime'}`;
  }
  return undefined;
}

function registerEntryImports(
  options: NormalizedModuleFederationOptions,
  projectRoot: string,
  recordShared = true,
  entryFiles: string[] = []
): boolean {
  const sourceExtensions = ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.vue', '.svelte'];
  const root = path.resolve(projectRoot);
  const pending: Array<{ file: string; preloadRemotes: boolean }> = [];
  const visited = new Map<string, boolean>();
  let hasJsxSource = false;
  const enqueue = (
    request: string,
    importer = path.join(root, 'index.html'),
    preloadRemotes = false
  ) => {
    const cleanRequest = request.replace(/[?#].*$/, '');
    if (
      !cleanRequest.startsWith('.') &&
      !cleanRequest.startsWith('/') &&
      !path.isAbsolute(cleanRequest)
    )
      return;
    const base = cleanRequest.startsWith('/')
      ? path.resolve(root, `.${cleanRequest}`)
      : path.resolve(path.dirname(importer), cleanRequest);
    const relative = path.relative(root, base);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
    const candidates = [
      base,
      ...sourceExtensions.map((extension) => `${base}${extension}`),
      ...sourceExtensions.map((extension) => path.join(base, `index${extension}`)),
    ];
    const file = candidates.find(isFile);
    if (file && (!visited.has(file) || (preloadRemotes && !visited.get(file)))) {
      pending.push({ file, preloadRemotes });
    }
  };

  const htmlEntries = entryFiles.filter((file) => file.endsWith('.html'));
  const htmlEntryPaths = htmlEntries.length
    ? htmlEntries
    : entryFiles.length === 0
      ? [path.join(root, 'index.html')]
      : [];
  for (const htmlEntry of htmlEntryPaths) {
    if (existsSync(htmlEntry)) {
      const html = readFileSync(htmlEntry, 'utf8');
      for (const match of html.matchAll(
        /<script\b(?=[^>]*\btype=["']module["'])(?=[^>]*\bsrc=(['"])([^'"]+)\1)[^>]*>/gi
      )) {
        enqueue(match[2], htmlEntry, true);
      }
    }
  }
  for (const entry of entryFiles.filter((file) => !file.endsWith('.html'))) {
    const relativeEntry = path.relative(root, entry);
    enqueue(
      relativeEntry.startsWith('.') ? relativeEntry : `./${relativeEntry}`,
      path.join(root, 'index.html'),
      true
    );
  }
  for (const expose of Object.values(options.exposes ?? {})) {
    enqueue(expose.import);
  }

  while (pending.length) {
    const { file, preloadRemotes } = pending.pop()!;
    if (visited.get(file) || (visited.has(file) && !preloadRemotes)) continue;
    visited.set(file, preloadRemotes);
    const code = getScannableModuleSource(file, readFileSync(file, 'utf8'));
    if (JSX_SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension))) hasJsxSource = true;
    for (const { source: request, kind, typeOnly } of findModuleImportDescriptors(code)) {
      const isStatic = kind === 'static' && !typeOnly;
      const remoteKey =
        preloadRemotes && isStatic && request
          ? Object.keys(options.remotes).find(
              (name) => request === name || request.startsWith(`${name}/`)
            )
          : undefined;
      const sharedKey = !typeOnly && request && findSharedKey(request, options.shared);
      if (remoteKey) {
        addUsedRemote(remoteKey, request, options);
        markStaticRemote(request, options);
        markPreloadRemote(request, options);
      } else if (sharedKey && recordShared) {
        addUsedShares(request, options);
      } else if (request && !typeOnly) {
        enqueue(request, file, preloadRemotes && isStatic);
      }
    }
  }
  return hasJsxSource;
}

// The compiler injects this import after the textual entry scan. Materialize
// the resolved runtime and its configured root even when optimizeDeps is warm.
function materializeAutomaticJsxRuntime(
  options: NormalizedModuleFederationOptions,
  runtime: string
): boolean {
  if (!findSharedKey(runtime, options.shared)) return false;
  addUsedShares(runtime, options);
  const packageName = getPackageName(runtime);
  if (packageName !== runtime && findSharedKey(packageName, options.shared)) {
    addUsedShares(packageName, options);
  }
  return true;
}

/**
 * Plugin that runs FIRST to register generated virtual modules in the config hook.
 * This prevents 504 "Outdated Optimize Dep" errors by ensuring ids are known
 * before Vite's optimization phase.
 */
function createEarlyVirtualModulesPlugin(options: NormalizedModuleFederationOptions): Plugin {
  const { shared, remotes } = options;
  const isLitShare = (pkg: string) => pkg === 'lit' || pkg.startsWith('lit/');
  let hasClientJsxSource = false;
  return {
    name: 'vite:module-federation-early-init',
    enforce: 'pre',
    config(config: UserConfig, { command: _command }) {
      if (_command === 'serve') ignoreFederationGeneratedFiles(config, options);

      const root = config.root || process.cwd();
      const buildInput = getBuildInput(config);
      const configuredEntryFiles =
        typeof buildInput === 'string'
          ? [buildInput]
          : Array.isArray(buildInput)
            ? buildInput
            : buildInput && typeof buildInput === 'object'
              ? Object.values(buildInput)
              : [];
      const resolvedConfiguredEntryFiles = configuredEntryFiles
        .map((entry) => String(entry))
        .filter((entry) => !isReactRouterBuildClientRouteInput(entry))
        .map((entry) => entry.split(/[?#]/)[0])
        .map((entry) => (path.isAbsolute(entry) ? entry : path.resolve(root, entry)));
      resetConcreteSharedImportSourceCache();
      setPackageDetectionCwd(root);
      const isVinext = hasPackageDependency('vinext');

      // Configure SSR runtime with the host's remotes so server-side loadRemote
      // knows the entry URL for each remote when ssrEntryLoader intercepts it.
      // Create core virtual modules
      initVirtualModules(_command, getRemoteEntryId(options), false, options);

      const isRolldown = getIsRolldown(this);

      // Eagerly register configured remotes before localSharedImportMap is
      // first written. In build, remoteEntry can be traced before app modules
      // hit the remote alias resolver, which otherwise leaves usedRemotes empty
      // in the emitted localSharedImportMap chunk.
      if (remotes && Object.keys(remotes).length > 0) {
        for (const key of Object.keys(remotes)) {
          addUsedRemote(key, key, options);
        }
        if (_command === 'serve') {
          config.optimizeDeps = config.optimizeDeps || {};
          config.optimizeDeps.exclude = config.optimizeDeps.exclude || [];
          config.optimizeDeps.include = config.optimizeDeps.include || [];
          // Prebundling bare remote specifiers rewrites imports like
          // `import("remote/x")` to optimized dep files. That bypasses the
          // remote namespace fixup path and can resolve same-named packages.
          config.optimizeDeps.exclude.push(...Object.keys(remotes || {}));
        }
      }

      if (
        !config.build?.ssr &&
        (Object.keys(shared ?? {}).length > 0 || Object.keys(remotes ?? {}).length > 0)
      ) {
        // The static remote registry is also needed by the production host
        // bootstrap. Keep share/optimize-deps discovery serve-only, but scan
        // the same client entry graph during build so the bootstrap can wait
        // for only the remotes imported synchronously by that graph.
        const hasJsxSource = registerEntryImports(
          options,
          root,
          _command === 'serve',
          resolvedConfiguredEntryFiles
        );
        if (_command === 'serve') hasClientJsxSource = hasJsxSource;
      }

      // Create shared module virtual files EARLY and register shares eagerly
      // so localSharedImportMap has content on first load in both serve/build.
      if (shared && Object.keys(shared).length > 0) {
        if (_command === 'serve') {
          excludeSharedSubDependencies(shared);
          config.optimizeDeps = config.optimizeDeps || {};
          config.optimizeDeps.include = config.optimizeDeps.include || [];
          const optimizeDeps = config.optimizeDeps as UserConfig['optimizeDeps'] & {
            rolldownOptions?: { plugins?: unknown[] };
            esbuildOptions?: { plugins?: unknown[] };
          };
          if (isRolldown) {
            optimizeDeps.rolldownOptions ??= {};
            optimizeDeps.rolldownOptions.plugins ??= [];
            optimizeDeps.rolldownOptions.plugins.push({
              name: 'module-federation:optimize-shared-resolver',
              load(id: string) {
                const optimizedRequirePrefix = 'module-federation:optimized-require-';
                if (!id.startsWith(optimizedRequirePrefix)) return;
                const sourcePackage = id.slice(optimizedRequirePrefix.length);
                if (sourcePackage !== 'react' && sourcePackage !== 'react-dom') return;
                const loadSharePath = getLoadShareModulePath(sourcePackage, isRolldown, options);
                // Keep the raw virtual id in Rolldown's generated optimized
                // dependency. Vite runs import analysis over the emitted file;
                // an already browser-encoded /@id/__x00__ specifier is treated
                // as an ordinary absolute import there and cannot be resolved.
                // The raw id is external to the optimizer, then resolved by the
                // federation virtual-module plugin when the file is served.
                const source = JSON.stringify(loadSharePath);
                return (
                  'import * as __mfShared from ' +
                  source +
                  ';\n' +
                  'export * from ' +
                  source +
                  ';\n' +
                  'export default __mfShared.default ?? __mfShared;'
                );
              },
              resolveId(source: string, importer?: string, resolveOptions?: { kind?: string }) {
                if (createViteEncodedIdPrefixRegExp('virtual:mf:').test(source)) {
                  return { id: source, external: true };
                }
                if (isSharedResolverInternalImporter(importer)) return;
                const key = findSharedKey(source, shared);
                if (!key) return;
                const importerPackage = getSharedPackageFromFile(importer, shared, root);
                const reactDomSelfReference = isReactDomSelfReference(source, importer);
                if (
                  !reactDomSelfReference &&
                  (importerPackage === getPackageName(key) ||
                    (importerPackage && isSharedPackageDependency(key, importerPackage)))
                )
                  return;
                if (isAssetLikeImport(source)) return;
                const shareItem = shared[key];
                const isReactSingleton =
                  source === 'react' &&
                  key === 'react' &&
                  shareItem.shareConfig?.singleton === true;
                const isReactRequire =
                  resolveOptions?.kind?.startsWith('require') && isReactSingleton;
                const isReactDomRequire =
                  resolveOptions?.kind?.startsWith('require') &&
                  isReactDomSelfReference(source, importer);
                if (
                  resolveOptions?.kind?.startsWith('require') &&
                  !isReactRequire &&
                  !isReactDomRequire
                )
                  return;
                if (isCommonJsImporter(importer) && !isReactSingleton && !isReactDomRequire) return;
                if (resolveOptions?.kind !== 'entry-point') addUsedShares(source, options);
                if (isReactRequire || isReactDomRequire) {
                  writeLoadShareModule(source, shareItem, _command, isRolldown, options);
                  if (shareItem.shareConfig?.import !== false) {
                    writePreBuildLibPath(source, shareItem, options);
                  }
                  return { id: `module-federation:optimized-require-${source}` };
                }
                const loadSharePath = getLoadShareModulePath(source, isRolldown, options);
                writeLoadShareModule(source, shareItem, _command, isRolldown, options);
                if (shareItem.shareConfig?.import !== false) {
                  writePreBuildLibPath(source, shareItem, options);
                }
                return { id: loadSharePath, external: true };
              },
            });
          } else {
            optimizeDeps.esbuildOptions ??= {};
            optimizeDeps.esbuildOptions.plugins ??= [];
            optimizeDeps.esbuildOptions.plugins.push({
              name: 'module-federation:optimize-shared-proxy',
              setup(build: any) {
                build.onResolve(
                  { filter: createViteEncodedIdPrefixRegExp('virtual:mf:') },
                  (args: any) => ({
                    path: args.path,
                    external: true,
                  })
                );
                build.onResolve({ filter: /.*/ }, (args: any) => {
                  if (args.kind === 'entry-point') return;
                  if (!args.importer || args.namespace === 'mf-shared') return;
                  if (isSharedResolverInternalImporter(args.importer)) return;
                  const key = findSharedKey(args.path, shared);
                  if (!key || isAssetLikeImport(args.path)) return;
                  const importerPackage = getSharedPackageFromFile(args.importer, shared, root);
                  if (
                    importerPackage === getPackageName(args.path) &&
                    !isReactDomSelfReference(args.path, args.importer)
                  )
                    return;
                  if (importerPackage && isSharedPackageDependency(key, importerPackage)) return;
                  addUsedShares(args.path, options);
                  if (args.kind === 'import-statement' || args.kind === 'dynamic-import') {
                    const shareItem = shared[key];
                    const loadSharePath = getLoadShareModulePath(args.path, isRolldown, options);
                    writeLoadShareModule(args.path, shareItem, _command, isRolldown, options);
                    if (shareItem.shareConfig?.import !== false) {
                      writePreBuildLibPath(args.path, shareItem, options);
                    }
                    return { path: loadSharePath, external: true };
                  }
                  return { path: args.path, namespace: 'mf-shared' };
                });
                build.onLoad({ filter: /.*/, namespace: 'mf-shared' }, (args: any) => {
                  const key = findSharedKey(args.path, shared);
                  if (!key) return;
                  const shareItem = shared[key];
                  const loadSharePath = getLoadShareModulePath(args.path, isRolldown, options);
                  writeLoadShareModule(args.path, shareItem, _command, isRolldown, options);
                  if (shareItem.shareConfig?.import !== false) {
                    writePreBuildLibPath(args.path, shareItem, options);
                  }
                  return {
                    loader: 'js',
                    resolveDir: root,
                    contents: `import * as __mfShared from ${JSON.stringify(loadSharePath)};
export * from ${JSON.stringify(loadSharePath)};
export default __mfShared.default ?? __mfShared;`,
                  };
                });
              },
            });
          }
        }
        for (const key of Object.keys(shared)) {
          const shareItem: ShareItem = shared[key];
          if (key.endsWith('/')) {
            if (_command === 'serve' && shareItem.shareConfig?.import !== false) {
              const optimizeDeps = (config.optimizeDeps ??= {});
              optimizeDeps.include ??= [];
              optimizeDeps.exclude ??= [];
              for (const subpath of getCommonSharedSubpaths(key)) {
                writePreBuildLibPath(subpath, shareItem, options);
                if (canResolveSharedSubpath(subpath, root)) {
                  optimizeDeps.include.push(subpath);
                } else {
                  optimizeDeps.exclude.push(subpath);
                }
              }
            }
            continue;
          }
          if (isVinext && key === 'react') {
            addConfiguredShare(key, options);
            continue;
          }
          getLoadShareModulePath(key, isRolldown, options);
          writeLoadShareModule(key, shareItem, _command, isRolldown, options);
          // Skip prebuild for shared deps with import: false — the host must
          // provide them, so no local fallback source is needed.
          if (shareItem.shareConfig?.import !== false) {
            writePreBuildLibPath(key, shareItem, options);
          }
          addConfiguredShare(key, options);
          if (_command === 'serve' && shareItem.shareConfig?.import !== false) {
            const optimizeDeps = (config.optimizeDeps ??= {});
            optimizeDeps.include ??= [];
            optimizeDeps.exclude ??= [];
            // Lit must stay outside dependency optimization because its
            // submodules rely on parent initialization order. Other shared
            // deps, including singleton React, must remain optimizable so
            // local prebuild fallbacks receive Vite's CJS-to-ESM interop.
            // Singleton identity is enforced by the federation share cache
            // and loadShare proxy, independently from dependency optimization.
            // Shares resolving to raw .jsx/.tsx source can't be optimized by
            // Vite at all, so route them to exclude the same way.
            const shouldBypassOptimizeDep = isLitShare(key) || !canResolveSharedSubpath(key, root);
            if (optimizeDeps.include.includes(key)) {
              optimizeDeps.exclude = optimizeDeps.exclude.filter((dep) => dep !== key);
            } else if (shouldBypassOptimizeDep || optimizeDeps.exclude.includes(key)) {
              optimizeDeps.exclude.push(key);
            } else {
              optimizeDeps.include.push(key);
            }
            for (const subpath of getCommonSharedSubpaths(key)) {
              const canResolveSubpath = canResolveSharedSubpath(subpath, root);
              if (
                ['react/compiler-runtime', 'react-dom/client', 'react-dom/profiling'].includes(
                  subpath
                ) &&
                !canResolveSubpath
              ) {
                // These entry points only exist in newer React versions.
                // Generating their prebuild wrappers for older versions creates
                // imports that Vite cannot resolve.
                optimizeDeps.exclude.push(subpath);
                continue;
              }
              getLoadShareModulePath(subpath, isRolldown, options);
              writeLoadShareModule(subpath, shareItem, _command, isRolldown, options);
              writePreBuildLibPath(subpath, shareItem, options);
              addConfiguredShare(subpath, options);
              if (canResolveSubpath) {
                optimizeDeps.include.push(subpath);
                // Prevent subpaths like react-dom/client from using a later, incompatible optimizer generation.
                if (key === 'react-dom') optimizeDeps.include.push(`${key} > ${subpath}`);
              } else {
                optimizeDeps.exclude.push(subpath);
              }
            }
          }
        }
        writeLocalSharedImportMap(options);
      }
      if (_command === 'serve') {
        config.optimizeDeps ??= {};
        includeLinkedSharedEntries(
          config.optimizeDeps,
          shared,
          root,
          options.exposes,
          config.build?.outDir ?? 'dist'
        );
        stabilizeOptimizeDeps(config.optimizeDeps);
      }
    },

    configResolved(config) {
      if (hasClientJsxSource) {
        const automaticJsxRuntime = getAutomaticJsxRuntime(config);
        if (automaticJsxRuntime && materializeAutomaticJsxRuntime(options, automaticJsxRuntime)) {
          writeLocalSharedImportMap(options);
        }
      }

      const viteMajor = parseInt(viteVersion, 10);
      const hasRemotes = Object.keys(options.remotes).length > 0;
      const ssrCapabilities = getSsrCapabilities(
        viteMajor,
        config.command as 'serve' | 'build',
        hasRemotes
      );
      if (!ssrCapabilities.injectSsrEntryLoader) return;

      const alreadyInjected = options.runtimePlugins.some((p) => {
        const specifier = typeof p === 'string' ? p : p[0];
        return specifier === SSR_ENTRY_LOADER_SPECIFIER;
      });
      if (alreadyInjected) return;

      const projectRequire = createRequire(pathToFileURL(path.join(config.root, 'package.json')));
      const sharedKeys = Object.keys(options.shared ?? {});
      const commonSharedPkgs = [
        'react',
        'react-dom',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'react/compiler-runtime',
        '@module-federation/runtime',
        '@module-federation/runtime-core',
        '@module-federation/sdk',
      ];
      const resolvedShared: Record<string, string> = {};
      for (const pkg of [...commonSharedPkgs, ...sharedKeys]) {
        try {
          resolvedShared[pkg] = projectRequire.resolve(pkg);
        } catch {
          try {
            resolvedShared[pkg] = resolveImportPath(pkg);
          } catch {
            // Not installed at either location — ssrEntryLoader falls back to
            // runtime resolution from the host app.
          }
        }
      }

      // Only inject when the built subpath export exists. Integration tests
      // run against src/ before a build, so the lib/ export won't be present.
      // Users can still inject manually via runtimePlugins in that case.
      const ssrEntryLoaderSpecifier = SSR_ENTRY_LOADER_SPECIFIER;
      try {
        resolveImportPath(ssrEntryLoaderSpecifier);
        options.runtimePlugins.push([ssrEntryLoaderSpecifier, { resolvedShared }]);
      } catch {
        // lib/ not built yet — skip silently
      }
    },
  };
}

type DefineConfig = NonNullable<UserConfig['define']>;

type RuntimeDefineContext = {
  target: 'web' | 'node';
  isAstro: boolean;
  defaultDisableSnapshot?: boolean;
};

function applyBuildTimeRuntimeDefines(
  define: DefineConfig,
  options: NormalizedModuleFederationOptions,
  { target, isAstro, defaultDisableSnapshot }: RuntimeDefineContext
): void {
  const envTargetDefineValue = !options.target && isAstro ? 'undefined' : JSON.stringify(target);

  if (!('ENV_TARGET' in define)) {
    define.ENV_TARGET = envTargetDefineValue;
  }
  applyRuntimeCapabilityDefines(define, options, {
    defaultDisableSnapshot,
    onConflict: mfWarn,
  });

  if (options.target && define.ENV_TARGET !== JSON.stringify(options.target)) {
    mfWarn(
      `ENV_TARGET define (${define.ENV_TARGET}) differs from target option ("${options.target}"). ENV_TARGET will not be overridden.`
    );
  }
}

function loadPluginDts(options: NormalizedModuleFederationOptions): any[] {
  if (options.dts === false) {
    return [];
  }

  return [import('./plugins/pluginDts').then(({ default: pluginDts }) => pluginDts(options))];
}

const INJECT_EXTERNAL_RUNTIME_CORE_PLUGIN =
  '@module-federation/vite/injectExternalRuntimeCorePlugin';

function isInjectExternalRuntimeCorePlugin(specifier: string): boolean {
  return (
    specifier === INJECT_EXTERNAL_RUNTIME_CORE_PLUGIN ||
    specifier.includes('injectExternalRuntimeCorePlugin') ||
    // Still recognize the official package if a consumer adds it manually.
    specifier.includes('inject-external-runtime-core-plugin')
  );
}

function hasInjectExternalRuntimeCorePlugin(
  runtimePlugins: Array<string | [string, Record<string, unknown>]>
): boolean {
  return runtimePlugins.some((plugin) => {
    const specifier = typeof plugin === 'string' ? plugin : plugin[0];
    return isInjectExternalRuntimeCorePlugin(specifier);
  });
}

function resolveInjectExternalRuntimeCorePlugin(): string {
  try {
    return normalizePathForImport(resolveImportPath(INJECT_EXTERNAL_RUNTIME_CORE_PLUGIN));
  } catch {
    // Dev/test before `lib/` exists: resolve the source/companion file beside this module.
    for (const rel of [
      './utils/injectExternalRuntimeCorePlugin.js',
      './utils/injectExternalRuntimeCorePlugin.ts',
    ]) {
      const candidate = fileURLToPath(new URL(rel, import.meta.url));
      if (existsSync(candidate)) return normalizePathForImport(candidate);
    }
    return INJECT_EXTERNAL_RUNTIME_CORE_PLUGIN;
  }
}

function applyExternalRuntimeExperiments(options: NormalizedModuleFederationOptions): void {
  const { experiments } = options;
  if (experiments.provideExternalRuntime) {
    if (Object.keys(options.exposes).length > 0) {
      throw createModuleFederationError(
        'You can only set provideExternalRuntime: true in pure consumer which not expose modules.'
      );
    }
    if (!hasInjectExternalRuntimeCorePlugin(options.runtimePlugins)) {
      options.runtimePlugins = options.runtimePlugins.concat(
        resolveInjectExternalRuntimeCorePlugin()
      );
    }
  }
}

function federation(mfUserOptions: ModuleFederationOptions): any[] {
  if (isTestEnv()) return [];
  const options = normalizeModuleFederationOptions(mfUserOptions);
  applyExternalRuntimeExperiments(options);

  const isVinext = hasPackageDependency('vinext');
  const { name, shared, filename, hostInitInjectLocation } = options;
  const hasTreeShakingShared = Object.values(shared).some(
    (share) => !!share.shareConfig.treeShaking
  );
  if (!name) throw createModuleFederationError('name is required');

  const remoteEntryId = getRemoteEntryId(options);
  const virtualExposesId = getVirtualExposesId(options);
  const moduleParseController = createModuleParseController();
  const moduleParsePlugins = pluginModuleParseEnd(
    (id: string) => {
      return (
        id.includes(getHostAutoInitPath(options)) ||
        id.includes(getPendingSharesPath(options)) ||
        id.includes(remoteEntryId) ||
        id.includes(virtualExposesId) ||
        id.includes('virtual:mf-localSharedImportMap') ||
        id.includes(LOAD_SHARE_TAG) ||
        id.includes(PREBUILD_TAG) ||
        id.includes(TREE_SHAKING_PROVIDER_TAG) ||
        id.includes(TREE_SHAKING_GRAPH_QUERY)
      );
    },
    {
      moduleParseTimeout: options.moduleParseTimeout,
      moduleParseIdleTimeout: options.moduleParseIdleTimeout,
      exposedModuleImports: Object.values(options.exposes).map((expose) => expose.import),
    },
    moduleParseController
  );

  let command: string;
  let desiredRolldownOutput: OutputNameOptions[] | undefined;
  let isSsrBuild = false;
  let isProduction = false;
  let rootResolveConditions: string[] | undefined;
  let ssrResolveConditions: string[] | undefined;
  let ssrTarget: 'node' | 'webworker' = 'node';
  const emittedRuntimeCapabilityWarnings = new Set<string>();

  type LoadHookOptions = { ssr?: boolean };
  type SharedVirtualRefreshStatus = 'refreshed' | 'not-owned' | 'not-applicable';
  type LoadHookContext = {
    environment?: {
      name?: string;
      config?: {
        consumer?: string;
        build?: { ssr?: boolean | string };
        isProduction?: boolean;
        resolve?: { conditions?: string[] };
      };
    };
  };

  const getLoadHookExportConditions = (context: LoadHookContext, loadOptions?: LoadHookOptions) => {
    const environment = context.environment;
    const isSsr =
      loadOptions?.ssr === true ||
      isSsrBuild ||
      environment?.config?.consumer === 'server' ||
      Boolean(environment?.config?.build?.ssr) ||
      environment?.name === 'ssr' ||
      environment?.name === 'server';
    return getSharedExportConditions({
      environmentConditions: environment?.config?.resolve?.conditions,
      isProduction: environment?.config?.isProduction ?? isProduction,
      isSsr,
      rootConditions: rootResolveConditions,
      ssrConditions: ssrResolveConditions,
      ssrTarget,
    });
  };

  const refreshLoadRemoteModuleForEnvironment = (
    id: string,
    context: LoadHookContext,
    loadOptions?: LoadHookOptions
  ) =>
    refreshRemoteModuleForEnvironment(
      id,
      options,
      getLoadHookExportConditions(context, loadOptions)
    );

  const refreshPreBuildModuleForEnvironment = (
    id: string,
    context: LoadHookContext,
    loadOptions?: LoadHookOptions
  ): SharedVirtualRefreshStatus => {
    const pkg = getCachedPreBuildPkg(id);
    if (!pkg) return 'not-applicable';
    const key = findSharedKey(pkg, shared);
    if (!key) return 'not-applicable';
    const requestedModule = VirtualModule.findById(id);
    const ownedModule = VirtualModule.findById(getPreBuildLibImportId(pkg, options));
    if (!requestedModule || requestedModule !== ownedModule) return 'not-owned';
    writePreBuildLibPath(
      pkg,
      shared[key],
      options,
      getLoadHookExportConditions(context, loadOptions)
    );
    return 'refreshed';
  };

  const refreshLoadShareModuleForEnvironment = (
    id: string,
    context: LoadHookContext,
    loadOptions?: LoadHookOptions,
    importFalseExportUsage?: ReturnType<typeof getSharedExportUsage>
  ): SharedVirtualRefreshStatus => {
    const pkg = getCachedLoadSharePkg(id);
    if (!pkg) return 'not-applicable';
    const key = findSharedKey(pkg, shared);
    if (!key) return 'not-applicable';
    const requestedModule = VirtualModule.findById(id);
    const ownedModule = VirtualModule.findById(getLoadShareModulePath(pkg, false, options));
    if (!requestedModule || requestedModule !== ownedModule) return 'not-owned';
    writeLoadShareModule(
      pkg,
      shared[key],
      command,
      getIsRolldown(context),
      options,
      getLoadHookExportConditions(context, loadOptions),
      importFalseExportUsage
    );
    return 'refreshed';
  };

  const getCompleteImportFalseExportUsage = (id: string) => {
    if (command !== 'build') return undefined;
    const pkg = getCachedLoadSharePkg(id);
    if (!pkg) return undefined;
    const key = findSharedKey(pkg, shared);
    if (!key || shared[key].shareConfig.import !== false) return undefined;

    return moduleParseController.parsePromise.then((completion) => {
      if (!completion.complete) {
        // The fallback is safe but invisible: without this the build silently
        // pays the barrier's timeout and emits the complete export surface.
        if (!moduleParseController.discardWarned) {
          moduleParseController.discardWarned = true;
          mfWarn(
            `import: false shared export analysis was discarded (reason: ${completion.reason})` +
              ' — falling back to the complete export surface, so shared consumers keep every' +
              ' detected named export.' +
              (completion.reason === 'idle-timeout' || completion.reason === 'timeout'
                ? ' If the build is simply slow, increasing moduleParseIdleTimeout may let the analysis finish.'
                : '')
          );
        }
        return undefined;
      }
      return getSharedExportUsage(pkg, shared[key], key, options);
    });
  };

  return [
    {
      name: 'vite:module-federation-virtual-modules',
      enforce: 'pre',
      configureServer(server: ViteDevServer) {
        server.watcher.on('change', invalidateSharedExportInspectionCache);
        server.watcher.on('add', invalidateSharedExportInspectionCache);
        server.watcher.on('unlink', invalidateSharedExportInspectionCache);
      },
      resolveId(id: string) {
        if (id === SSR_ENTRY_LOADER_SPECIFIER) return resolveImportPath(id);
        let virtualModule = VirtualModule.findById(id);
        if (!virtualModule) {
          materializeCachedLoadShareModule({
            id,
            shared: options.shared,
            command,
            isRolldown: getIsRolldown(this),
            findSharedKey,
            addUsedShares: (pkg) => addUsedShares(pkg, options),
            writeLocalSharedImportMap: () => writeLocalSharedImportMap(options),
            federationOptions: options,
          });
          virtualModule =
            VirtualModule.findById(id) ??
            findCurrentLoadShareForStaleOwnerId(id, options.shared, findSharedKey, options);
        }
        if (!virtualModule) return;
        return virtualModule.getResolvedId();
      },
      load(id: string, loadOptions?: LoadHookOptions) {
        if (
          id.includes(LOAD_REMOTE_TAG) &&
          !refreshLoadRemoteModuleForEnvironment(id, this as LoadHookContext, loadOptions)
        ) {
          return;
        }
        if (command !== 'build' && id.includes(LOAD_SHARE_TAG)) {
          id =
            findCurrentLoadShareForStaleOwnerId(
              id,
              options.shared,
              findSharedKey,
              options
            )?.getResolvedId() ?? id;
          if (
            refreshLoadShareModuleForEnvironment(id, this as LoadHookContext, loadOptions) ===
            'not-owned'
          )
            return;
        }
        if (
          id.includes(PREBUILD_TAG) &&
          refreshPreBuildModuleForEnvironment(id, this as LoadHookContext, loadOptions) ===
            'not-owned'
        ) {
          return;
        }
        if (id.includes(HOST_AUTO_INIT_TAG) && isOwnedHostAutoInitId(id, options)) {
          refreshHostAutoInit(
            options,
            getLoadHookExportConditions(this as LoadHookContext, loadOptions)
          );
        }
        if (id.includes(PENDING_SHARES_TAG) && isOwnedPendingSharesId(id, options)) {
          refreshPendingShares(options);
        }
        const virtualModule = VirtualModule.findById(id);
        if (!virtualModule) return;
        if (command === 'build' && (id.includes(LOAD_SHARE_TAG) || id.includes(LOAD_REMOTE_TAG))) {
          return;
        }
        return virtualModule.code;
      },
    },
    ...(options.experiments.externalRuntime ? [pluginExternalRuntimeCore()] : []),
    // This plugin runs FIRST to register virtual modules before optimization
    createEarlyVirtualModulesPlugin(options),
    ...(isVinext
      ? [
          {
            name: 'module-federation-vinext-react-server-build-alias',
            apply: 'build' as const,
            enforce: 'pre' as const,
            resolveId(id: string) {
              const reactServerEntryMap: Record<string, string> = {
                'react/jsx-runtime': 'react/cjs/react-jsx-runtime.production.js',
                'react/jsx-dev-runtime': 'react/cjs/react-jsx-dev-runtime.production.js',
                'react/compiler-runtime': 'react/cjs/react-compiler-runtime.production.js',
              };
              if (!(id in reactServerEntryMap)) return;
              const environmentName = (this as { environment?: { name?: string } }).environment
                ?.name;
              if (!environmentName || environmentName === 'client') return;

              const target = reactServerEntryMap[id];
              const projectRequire = createRequire(
                pathToFileURL(path.join(process.cwd(), 'package.json'))
              );
              const reactPackageJson = projectRequire.resolve('react/package.json');
              return path.join(path.dirname(reactPackageJson), target.replace(/^react\//, ''));
            },
          },
        ]
      : []),
    {
      name: 'vite:module-federation-config',
      enforce: 'pre',
      config(_config: UserConfig, env: ConfigEnv) {
        command = env.command;
      },
      configResolved(config: ResolvedConfig) {
        rootResolveConditions = config.resolve?.conditions
          ? [...config.resolve.conditions]
          : undefined;
        ssrResolveConditions = config.ssr?.resolve?.conditions
          ? [...config.ssr.resolve.conditions]
          : undefined;
        ssrTarget = config.ssr?.target ?? 'node';
        isProduction = config.isProduction;
        const ssrCapabilities = getSsrCapabilities(
          parseInt(viteVersion, 10),
          command as 'serve' | 'build',
          Object.keys(options.remotes).length > 0
        );
        initVirtualModules(command, remoteEntryId, ssrCapabilities.enableSsrInitBootstrap, options);
      },
    },
    aliasToArrayPlugin,
    checkAliasConflicts({ shared }),
    normalizeOptimizeDepsPlugin,
    ...loadPluginDts(options),
    pluginDevRemoteHmr(options),
    {
      // Some frameworks (e.g. TanStack Start) assume the bundle has exactly one
      // isEntry chunk and throw when they see extras. MF emits additional entry
      // chunks (hostInit, remoteEntry, virtualExposes) that are not the real app
      // entry. Mark them as non-entry before any framework scanner runs.
      name: 'mf:normalize-entry-chunks',
      enforce: 'pre',
      apply: 'build',
      generateBundle(_options: unknown, bundle: Record<string, unknown>) {
        for (const chunk of Object.values(bundle)) {
          if (
            typeof chunk !== 'object' ||
            chunk === null ||
            (chunk as { type: string }).type !== 'chunk' ||
            !(chunk as { isEntry: boolean }).isEntry
          )
            continue;
          const facadeId = (chunk as { facadeModuleId?: string }).facadeModuleId ?? '';
          if (
            facadeId.includes('__mf__virtual') ||
            facadeId.startsWith('virtual:mf-') ||
            facadeId.startsWith('virtual:mf:') ||
            facadeId.startsWith('\0virtual:mf-') ||
            facadeId.startsWith('\0virtual:mf:')
          ) {
            (chunk as { isEntry: boolean }).isEntry = false;
          }
        }
      },
    },
    ...addEntry({
      entryName: 'remoteEntry',
      entryPath: remoteEntryId,
      fileName: filename,
      federationOptions: options,
    }),
    ...addEntry({
      entryName: 'hostInit',
      entryPath: () => getHostAutoInitPath(options),
      inject: hostInitInjectLocation,
      forceClientInjected: Object.keys(options.exposes).length > 0,
      skipTransformFor: Object.values(options.exposes).map((expose) => expose.import),
      federationOptions: options,
    }),
    ...addEntry({
      entryName: 'virtualExposes',
      entryPath: virtualExposesId,
      federationOptions: options,
    }),
    pluginProxyRemoteEntry({
      options,
      remoteEntryId,
      virtualExposesId,
      getParsePromise: () => moduleParseController.parsePromise,
    }),
    pluginProxyRemotes(options),
    pluginRemoteNamedExports(options),
    ...moduleParsePlugins,
    ...proxySharedModule({
      shared,
      federationOptions: options,
      getParsePromise: () => moduleParseController.parsePromise,
    }),
    {
      name: 'module-federation-esm-shims',
      enforce: 'pre',
      apply: 'build',
      config(config: UserConfig) {
        isSsrBuild = Boolean(config.build?.ssr);
        // Force loadShare modules and runtimeInitStatus into separate chunks.
        //
        // For Vite 8+: loadShare chunks need separate async init barriers
        // so the generateBundle hook can patch generated CJS factories.
        //
        // For Rollup (standard vite): runtimeInitStatus MUST be in its own chunk
        // to break init deadlock: loadShare waits for initPromise, remoteEntry
        // resolves initPromise via initResolve. If both are in the same chunk,
        // loadShare blocks remoteEntry from ever executing.
        const runtimeInitId = getRuntimeInitStatusImportId(options);
        config.build = config.build || {};

        if (config.build.modulePreload !== false) {
          const currentModulePreload =
            config.build.modulePreload && typeof config.build.modulePreload === 'object'
              ? config.build.modulePreload
              : {};
          const existingResolveDependencies = currentModulePreload.resolveDependencies;

          config.build.modulePreload = {
            ...currentModulePreload,
            resolveDependencies(
              filename: string,
              deps: string[],
              context: ModulePreloadResolveContext
            ) {
              const resolvedDeps = existingResolveDependencies
                ? existingResolveDependencies(filename, deps, context)
                : deps;
              const hostFile = path.basename(context.hostId);
              const shouldSkipFederationPreload =
                context.hostType === 'js' &&
                (hostFile === options.filename ||
                  hostFile.includes('hostInit') ||
                  hostFile.includes('virtualExposes') ||
                  hostFile.includes('localSharedImportMap'));

              if (shouldSkipFederationPreload) return [];

              const hasFederationHtmlDeps =
                context.hostType === 'html' &&
                resolvedDeps.some((dep) => isFederationHtmlPreloadDependency(dep));
              const hasFederationJsDeps =
                context.hostType === 'js' &&
                resolvedDeps.some((dep) => isFederationHtmlPreloadDependency(dep));

              const treeShakingFallbackDeps = hasTreeShakingShared
                ? (dep: string) => dep.includes('__prebuild__')
                : () => false;

              return hasFederationHtmlDeps || hasFederationJsDeps
                ? resolvedDeps.filter(
                    (dep) =>
                      !isFederationHtmlPreloadDependency(dep, true) && !treeShakingFallbackDeps(dep)
                  )
                : resolvedDeps.filter((dep) => !treeShakingFallbackDeps(dep));
            },
          };
        }

        let warnedAboutCodeSplitting = false;
        const ensureCodeSplitting = (output: MutableBundlerOutput) => {
          if (output?.codeSplitting !== false) return;
          delete output.codeSplitting;
          if (warnedAboutCodeSplitting) return;
          warnedAboutCodeSplitting = true;
          mfWarn(
            'Ignoring `output.codeSplitting = false` because module federation requires chunk splitting.'
          );
        };

        // Groups installed by applyManualChunks, matched by object identity (not
        // name) so a user group named like a federation group isn't filtered out.
        const isFederationGroup = (group: unknown): boolean =>
          typeof group === 'object' && group !== null && federationGroups.has(group);

        let warnedAboutGroupPriority = false;
        // Keep user groups, but clamp their priority below the federation groups so
        // they can only claim modules the federation groups didn't.
        const clampUserGroup = (group: unknown): unknown => {
          const candidate = group as Partial<CodeSplittingGroup>;
          if (typeof candidate?.priority !== 'number') return group;
          if (candidate.priority <= USER_GROUP_MAX_PRIORITY) return group;
          if (!warnedAboutGroupPriority) {
            warnedAboutGroupPriority = true;
            mfWarn(
              `Clamping \`output.codeSplitting.groups\` priority to ${USER_GROUP_MAX_PRIORITY} — ` +
                'module federation groups must keep the highest priority so shared dependency init ' +
                'wrappers stay isolated in their own chunks.'
            );
          }
          return { ...candidate, priority: USER_GROUP_MAX_PRIORITY };
        };

        let warnedAboutManualChunks = false;
        let warnedAboutObjectManualChunks = false;
        // `useCodeSplitting` selects the bundler-appropriate isolation mechanism:
        // Rolldown (Vite 8+) supports `codeSplitting` (and needs it to relocate the
        // injected preload helper), while Rollup (Vite 5–7) only understands
        // `manualChunks` and rejects `codeSplitting` as an unknown output option.
        const applyManualChunks = (output: MutableBundlerOutput, useCodeSplitting: boolean) => {
          ensureCodeSplitting(output);
          const isPatchedByPlugin =
            typeof output.manualChunks === 'function' &&
            patchedManualChunks.has(output.manualChunks);
          const mfChunkName = function (id: string): string | null {
            // Keep runtimeInitStatus in its own chunk to break init deadlock
            if (id.includes(runtimeInitId) || id.includes('__mf_v__runtimeInit__mf_v__')) {
              return 'runtimeInit';
            }
            if (id.includes(LOAD_SHARE_TAG)) {
              // Use the virtual module path as the chunk name
              const match = id.match(/([^/\\]+__loadShare__[^/\\]+)/);
              return match ? match[1] : 'loadShare';
            }
            return null;
          };
          patchedManualChunks.add(mfChunkName);

          if (!useCodeSplitting) {
            // Rollup (Vite 5–7): `codeSplitting` is rejected as an unknown output
            // option, so isolate runtimeInit, loadShare, and the preload helper with
            // `manualChunks`. A user-provided manualChunks function is composed in as
            // a fallback: federation modules are claimed first, everything else falls
            // through to the user's function.
            if (isPatchedByPlugin) return;
            const userManualChunks = output.manualChunks;
            if (
              userManualChunks &&
              typeof userManualChunks !== 'function' &&
              !warnedAboutObjectManualChunks
            ) {
              warnedAboutObjectManualChunks = true;
              mfWarn(
                'Ignoring the object form of `output.manualChunks` because module federation cannot ' +
                  'safely compose with it. Use the function form instead: federation modules are claimed ' +
                  'first and your function runs for everything else.'
              );
            }
            const mfManualChunks = function (id: string, ...rest: unknown[]) {
              if (PRELOAD_HELPER_TEST.test(id)) return PRELOAD_HELPER_CHUNK;
              const mfChunk = mfChunkName(id);
              if (mfChunk) return mfChunk;
              if (typeof userManualChunks === 'function') {
                return userManualChunks(id, ...rest) ?? undefined;
              }
              return undefined;
            };
            patchedManualChunks.add(mfManualChunks);
            output.manualChunks = mfManualChunks;
            return;
          }

          // Rolldown (Vite 8+): `manualChunks` cannot relocate the injected preload
          // helper (Rolldown ignores its placement), so use `codeSplitting` instead:
          // a dynamic `name()` group reproduces the runtimeInit/loadShare isolation,
          // and a higher-priority `test` group pulls the preload helper into its own
          // chunk (the helper is only matched by `test`, never the `name()` fn).
          // User groups are kept, clamped below the federation priorities, so they
          // can only claim modules the federation groups leave behind.
          if (output.manualChunks && !isPatchedByPlugin && !warnedAboutManualChunks) {
            warnedAboutManualChunks = true;
            mfWarn(
              'Ignoring `output.manualChunks` for the Rolldown build because module federation manages ' +
                'chunking with `output.codeSplitting.groups`. Move your grouping there — user groups are ' +
                'kept below the federation groups.'
            );
          }
          const existingGroups = (
            output.codeSplitting && typeof output.codeSplitting === 'object'
              ? output.codeSplitting.groups
              : undefined
          ) as unknown[] | undefined;
          const userGroups = Array.isArray(existingGroups)
            ? existingGroups.filter((group) => !isFederationGroup(group)).map(clampUserGroup)
            : [];
          const mfPreloadGroup = {
            name: PRELOAD_HELPER_CHUNK,
            test: PRELOAD_HELPER_TEST,
            priority: MF_GROUP_PRIORITY + 1,
          };
          const mfNameGroup = { name: mfChunkName, priority: MF_GROUP_PRIORITY };
          federationGroups.add(mfPreloadGroup);
          federationGroups.add(mfNameGroup);
          const groups = [mfPreloadGroup, mfNameGroup, ...userGroups];
          output.codeSplitting = { ...(output.codeSplitting || {}), groups };
          delete output.manualChunks;
        };

        config.build.rollupOptions = config.build.rollupOptions || {};
        const rollupOutput = config.build.rollupOptions.output;
        if (Array.isArray(rollupOutput)) {
          rollupOutput.forEach((output) =>
            applyManualChunks(output as MutableBundlerOutput, false)
          );
        } else {
          applyManualChunks(
            (config.build.rollupOptions.output ||= {}) as MutableBundlerOutput,
            false
          );
        }

        // Vite 8+ reads build.rolldownOptions instead of rollupOptions. Apply the
        // same runtimeInit/loadShare isolation there, but via `codeSplitting` so the
        // Rolldown-injected preload helper can also be pulled into its own chunk.
        const buildWithRolldown = config.build as typeof config.build & {
          rolldownOptions?: RolldownOptionsLike;
        };
        buildWithRolldown.rolldownOptions = buildWithRolldown.rolldownOptions || {};
        const rolldownOutput = buildWithRolldown.rolldownOptions.output as
          | MutableBundlerOutput
          | MutableBundlerOutput[]
          | undefined;
        const snapshotRolldownOutput = (output: MutableBundlerOutput): OutputNameOptions => ({
          entryFileNames: output.entryFileNames,
          chunkFileNames: output.chunkFileNames,
          assetFileNames: output.assetFileNames,
        });
        if (Array.isArray(rolldownOutput)) {
          rolldownOutput.forEach((output) => applyManualChunks(output, true));
          desiredRolldownOutput = rolldownOutput.map((output) => snapshotRolldownOutput(output));
        } else {
          applyManualChunks(
            (buildWithRolldown.rolldownOptions.output ||= {}) as MutableBundlerOutput,
            true
          );
          // Vite 8's Rolldown build path overwrites output options like
          // entryFileNames/chunkFileNames/assetFileNames. Keep only those
          // values so we can restore them in buildApp without clobbering other
          // later output mutations from Vite or plugins.
          desiredRolldownOutput = [
            snapshotRolldownOutput(
              buildWithRolldown.rolldownOptions.output as MutableBundlerOutput
            ),
          ];
        }
      },
      async buildApp(builder: BuilderLike) {
        const desiredOutput = desiredRolldownOutput;
        if (!desiredOutput) return;

        const applyRolldownOutput = (
          output: MutableBundlerOutput | undefined,
          restoredOutput: OutputNameOptions | undefined
        ) => {
          if (!output || !restoredOutput) return;
          if (restoredOutput.entryFileNames !== undefined) {
            output.entryFileNames = restoredOutput.entryFileNames;
          }
          if (restoredOutput.chunkFileNames !== undefined) {
            output.chunkFileNames = restoredOutput.chunkFileNames;
          }
          if (restoredOutput.assetFileNames !== undefined) {
            output.assetFileNames = restoredOutput.assetFileNames;
          }
        };

        for (const environment of Object.values(builder.environments)) {
          const getRolldownOptions = environment.getRolldownOptions;
          if (typeof getRolldownOptions !== 'function') continue;

          environment.getRolldownOptions = async () => {
            const rolldownOptions = (await getRolldownOptions.call(
              environment
            )) as RolldownOptionsLike;
            if (Array.isArray(rolldownOptions.output)) {
              rolldownOptions.output.forEach((output, index: number) => {
                applyRolldownOutput(output, desiredOutput[index]);
              });
            } else {
              rolldownOptions.output ||= {};
              applyRolldownOutput(rolldownOptions.output, desiredOutput[0]);
            }
            return rolldownOptions;
          };
        }
      },
      load(id: string, loadOptions?: LoadHookOptions) {
        const commonJsProxySuffix = '?commonjs-proxy';
        if (id.includes(LOAD_SHARE_TAG) && id.endsWith(commonJsProxySuffix)) {
          const target = id.slice(id.startsWith('\0') ? 1 : 0, -commonJsProxySuffix.length);
          return `export { __moduleExports as default } from ${JSON.stringify(target)};`;
        }

        const loadVirtualModule = (
          importFalseExportUsage?: ReturnType<typeof getSharedExportUsage>
        ) => {
          if (!id.includes(LOAD_SHARE_TAG) && !id.includes(LOAD_REMOTE_TAG)) return;
          if (
            id.includes(LOAD_REMOTE_TAG) &&
            !refreshLoadRemoteModuleForEnvironment(id, this as LoadHookContext, loadOptions)
          ) {
            return;
          }
          if (
            id.includes(LOAD_SHARE_TAG) &&
            refreshLoadShareModuleForEnvironment(
              id,
              this as LoadHookContext,
              loadOptions,
              importFalseExportUsage
            ) === 'not-owned'
          ) {
            return;
          }
          const virtualModule = VirtualModule.findById(id);
          if (!virtualModule?.code) return null;
          let code = virtualModule.code;

          const environmentName = (this as { environment?: { name?: string } }).environment?.name;
          // Vite 5-7 SSR builds do not expose `this.environment`, so fall back to root
          // build.ssr to ensure SSR-only local fallback imports are still prepended.
          if (
            (environmentName && environmentName !== 'client') ||
            (!environmentName && isSsrBuild)
          ) {
            code = prependWorkspaceSingletonSsrImport(code);
          }

          // Remove static imports/re-exports of prebuild modules to prevent
          // Rollup from merging them into the loadShare chunk.  Without this,
          // Rollup deduplicates and merges React code into the loadShare chunk,
          // so get() in localSharedImportMap ends up dynamically importing the
          // SAME chunk whose async init is already executing, causing deadlock.
          // The prebuild modules remain reachable via the dynamic import() in
          // localSharedImportMap's get() function, which naturally creates a
          // separate chunk.
          code = code.replace(/import\s+["'][^"']*__prebuild__[^"']*["']\s*;?/g, '');
          code = code.replace(/export\s+\*\s+from\s+["'][^"']*__prebuild__[^"']*["']\s*;?/g, '');

          /**
           * Shared/remote shims only have `export default exportModule`.
           *
           * We add a second named export (__moduleExports) that holds the full
           * module namespace and point syntheticNamedExports at it.  This lets
           * Rollup resolve named imports (e.g. `import { useState } from 'react'`)
           * from the namespace while still applying its normal default-export
           * interop — which is needed for libraries like @emotion/styled where
           * `import styled from '@emotion/styled'` must receive the .default
           * function, not the raw namespace object.
           *
           * Using 'default' as the syntheticNamedExports key would skip the
           * interop and break default imports.
           *
           * @see https://rollupjs.org/plugin-development/#synthetic-named-exports
           */
          const hasModuleExports =
            /\b(?:var|let|const)\s+__moduleExports\b/.test(code) ||
            /\bexport\s+const\s+__moduleExports\b/.test(code) ||
            /\bexport\s*\{[^}]*__moduleExports/.test(code);

          if (!hasModuleExports) {
            const nextCode = code.replace(
              'export default exportModule',
              'export const __moduleExports = exportModule;\n' +
                'export default exportModule.__esModule ? exportModule.default : exportModule'
            );
            code =
              nextCode === code
                ? `${code}\nexport const __moduleExports = exportModule;\n`
                : nextCode;
          }
          // Rollup supports syntheticNamedExports to resolve named imports
          // from the __moduleExports namespace.  Rolldown (Vite 8+) does not
          // support this — the pluginRemoteNamedExports transform handles
          // named-export resolution on the consumer side instead.
          if (getIsRolldown(this)) {
            return { code };
          }
          return { code, syntheticNamedExports: '__moduleExports' };
        };

        const pendingImportFalseExportUsage = id.includes(LOAD_SHARE_TAG)
          ? getCompleteImportFalseExportUsage(id)
          : undefined;
        if (pendingImportFalseExportUsage) {
          return pendingImportFalseExportUsage.then(loadVirtualModule);
        }
        return loadVirtualModule();
      },
      generateBundle(
        _outputOptions: NormalizedOutputOptionsLike,
        bundle: BundleLike,
        _isWrite: boolean
      ) {
        for (const [fileName, chunk] of Object.entries(bundle)) {
          if (!isOutputChunk(chunk)) continue;
          if (!isFederationControlChunk(fileName, filename)) continue;

          chunk.code = sanitizeFederationControlChunk(chunk.code, fileName, filename);
        }

        // Break transitive proxy deadlock.
        //
        // Rollup's CJS plugin creates commonjs-proxy wrapper chunks for
        // loadShare modules. These proxies share CJS helpers
        // (getDefaultExportFromCjs, getAugmentedNamespace) with prebuild
        // chunks (react, react-dom). This creates a transitive dependency:
        //   prebuild chunk -> commonjs-proxy -> loadShare chunk
        // When get() dynamically imports the prebuild chunk during
        // loadShare execution, it blocks on itself, causing deadlock.
        //
        // Fix: extract helper functions from commonjs-proxy chunks and
        // inline them in consuming chunks, then remove the proxy imports.
        const proxyChunks = collectLoadShareProxyChunks(bundle, LOAD_SHARE_TAG);
        if (proxyChunks.size > 0) {
          const systemProxyInfo = collectSystemProxyInfos(proxyChunks, LOAD_SHARE_TAG);

          // Extract helper functions from each proxy chunk.
          // Proxy chunks export: standalone helpers + wrapped loadShare namespace.
          // We only inline the standalone helpers; namespace deps are redirected.
          for (const [fileName, chunk] of Object.entries(bundle)) {
            if (!isOutputChunk(chunk)) continue;
            if (proxyChunks.has(fileName)) continue;

            let code = chunk.code;
            if (!fileName.includes(LOAD_SHARE_TAG)) {
              code = rewriteEsmProxyConsumers(code, proxyChunks);
            }

            code = rewriteSystemProxyConsumers(code, systemProxyInfo);

            if (code !== chunk.code) {
              chunk.code = code;
            }
          }
        }
      },
    },
    {
      name: 'module-federation-strip-empty-preload-helper',
      enforce: 'post' as const,
      apply: 'build' as const,
      renderChunk(code: string, chunk: RenderedChunkLike) {
        if (!isFederationControlChunk(chunk.fileName, filename)) return;

        const nextCode = sanitizeFederationControlChunk(code, chunk.fileName, filename);

        return nextCode === code ? null : { code: nextCode, map: null };
      },
      writeBundle(outputOptions: NormalizedOutputOptionsLike, bundle: BundleLike) {
        if (!outputOptions.dir) return;

        for (const chunk of Object.values(bundle)) {
          if (!isOutputChunk(chunk)) continue;
          if (!isFederationControlChunk(chunk.fileName, filename)) continue;

          const outputPath = path.join(outputOptions.dir, chunk.fileName);
          const nextCode = sanitizeFederationControlChunk(
            readFileSync(outputPath, 'utf-8'),
            chunk.fileName,
            filename
          );

          writeFileSync(outputPath, nextCode);
        }
      },
    },
    {
      name: 'module-federation-vite',
      enforce: 'post',
      // used to expose plugin options: https://github.com/rolldown/rolldown/discussions/2577#discussioncomment-11137593
      _options: options,
      config(config: UserConfig, { command: _command }: { command: string }) {
        const isRolldown = getIsRolldown(this);
        isSsrBuild = _command === 'build' && Boolean(config.build?.ssr);
        const needsRuntimeHelpers = Object.keys(options.shared ?? {}).length > 0;

        if (needsRuntimeHelpers) {
          appendResolveAlias(config, {
            find: /^@module-federation\/runtime\/helpers$/,
            replacement: getRuntimeHelpersImplementation(options.implementation),
          });
        }

        appendResolveAlias(config, {
          find: /^@module-federation\/runtime$/,
          replacement: options.implementation,
        });
        config.build ||= {};
        config.build.commonjsOptions ||= {};
        config.build.commonjsOptions.strictRequires ??= 'auto';
        config.optimizeDeps ||= {};
        config.optimizeDeps.include ||= [];
        config.optimizeDeps.include.push('@module-federation/runtime');
        if (needsRuntimeHelpers) {
          config.optimizeDeps.include.push('@module-federation/runtime/helpers');
        }

        // Add all runtime plugins to optimizeDeps to prevent 504 re-optimization.
        // SSR-only plugins import Node modules — exclude them from browser optimisation.
        options.runtimePlugins.forEach((p) => {
          const pluginPath = typeof p === 'string' ? p : p[0];
          if (SSR_ONLY_RUNTIME_PLUGINS.has(pluginPath)) return;
          // Only add bare imports to optimizeDeps
          if (
            pluginPath &&
            !pluginPath.startsWith('.') &&
            !pluginPath.startsWith('/') &&
            !pluginPath.startsWith('\0') &&
            !pluginPath.startsWith('virtual:')
          ) {
            let optimizeDep = pluginPath;
            if (pluginPath === '@module-federation/dts-plugin/dynamic-remote-type-hints-plugin') {
              try {
                optimizeDep = normalizePathForImport(resolveImportPath(pluginPath));
              } catch {
                optimizeDep = pluginPath;
              }
            }
            config.optimizeDeps!.include!.push(optimizeDep);
          }
        });

        if (isRolldown) {
          // Vite 8+: virtual modules use ESM.
          config.build ??= {};
          config.build.target ??= 'esnext';
        }

        const isAstro = hasPackageDependency('astro');
        // Resolve target: explicit option > SSR detection > 'web'
        // (Environment API server/ssr targets are set in configEnvironment.)
        const resolvedTarget = options.target ?? (config.build?.ssr ? 'node' : 'web');

        if (!config.define) config.define = {};
        applyBuildTimeRuntimeDefines(config.define, options, {
          target: resolvedTarget,
          isAstro,
          defaultDisableSnapshot: resolvedTarget === 'node' ? true : undefined,
        });

        for (const warning of getRuntimeCapabilityConfigurationWarnings(options)) {
          if (emittedRuntimeCapabilityWarnings.has(warning)) continue;
          emittedRuntimeCapabilityWarnings.add(warning);
          mfWarn(warning);
        }
      },
      configResolved(config: ResolvedConfig) {
        // TanStack Start/Nitro performs its server build from a deferred
        // closeBundle task. Some example integrations add a build-exit hook
        // that calls process.exit() immediately, which aborts that task after
        // the client build and leaves .output/server/index.mjs missing.
        // Disable only that explicitly named workaround; other exit hooks and
        // non-Nitro projects remain untouched.
        if (!hasPackageDependency('nitro')) return;
        const prematureExit = config.plugins.find(
          (plugin) => plugin.name === 'tanstack-build-exit'
        );
        if (prematureExit) {
          prematureExit.closeBundle = undefined;
        }
      },
      configEnvironment(name: string, config: EnvironmentOptions) {
        const isServerEnvironment =
          config.consumer === 'server' ||
          name === 'ssr' ||
          name === 'server' ||
          config.build?.ssr === true;
        // Client graphs keep ENV_TARGET from root config(); only server/ssr envs need node.
        if (!isServerEnvironment) return;

        const isAstro = hasPackageDependency('astro');
        // Copy define per environment — Vite may reuse the same object across envs.
        config.define = { ...(config.define ?? {}) };
        applyBuildTimeRuntimeDefines(config.define, options, {
          target: options.target ?? 'node',
          isAstro,
          defaultDisableSnapshot: true,
        });
      },
    },
    ...pluginManifest(options),
    ...pluginSSRRemoteEntry(options),
    ...pluginVarRemoteEntry(options),
    {
      name: 'module-federation-vinext-fix-rsc-preload-as',
      enforce: 'post' as const,
      configureServer(server) {
        if (!hasPackageDependency('vinext')) return;

        server.middlewares.use((req, res, next) => {
          if (!req.headers.accept?.includes('text/html')) {
            next();
            return;
          }

          const chunks: Buffer[] = [];
          const end = res.end.bind(res);

          res.write = (chunk: any) => {
            if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            return true;
          };

          res.end = (chunk: any, ...args: any[]) => {
            if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            const body = normalizeVinextRscPreloadHints(Buffer.concat(chunks).toString());
            return end(body, ...args);
          };

          next();
        });
      },
      generateBundle(_: NormalizedOutputOptionsLike, bundle: BundleLike, _isWrite: boolean) {
        if (!hasPackageDependency('vinext')) return;

        for (const chunk of Object.values(bundle)) {
          if (!isOutputChunk(chunk)) continue;
          if (!chunk.code.includes('case"L"')) continue;

          chunk.code = chunk.code.replace(
            /case"L":(\w+)=(\w+)\[0\],(\w+)=\2\[1\],\2\.length===3\?(\w+)\.L\(\1,\3,\2\[2\]\):\4\.L\(\1,\3\)/g,
            'case"L":$1=$2[0],$3=$2[1],$3==="stylesheet"&&($3="style"),$2.length===3?$4.L($1,$3,$2[2]):$4.L($1,$3)'
          );
        }
      },
    } satisfies Plugin,
    // Fix preload helper for federated remotes: Vite's preload helper resolves
    // asset URLs against the page origin (e.g. host), but remote chunks need
    // to resolve against their own origin. Replace the hardcoded base URL
    // function with import.meta.url-based resolution.
    ...(function () {
      let disablePreload = false;

      return Object.keys(options.exposes).length > 0
        ? [
            {
              name: 'module-federation-fix-preload',
              enforce: 'post' as const,
              apply: 'build' as const,
              config(_config, { command }) {
                const manifest = options.manifest;
                const getDefaultDisableAssetsAnalyze = (cfgCommand: string | undefined) =>
                  cfgCommand === 'serve' &&
                  (typeof manifest !== 'object' ||
                    !Object.prototype.hasOwnProperty.call(manifest, 'disableAssetsAnalyze'));

                const getConfiguredDisableAssetsAnalyze = (cfgCommand: string | undefined) => {
                  if (typeof manifest === 'object' && manifest !== null) {
                    if (Object.prototype.hasOwnProperty.call(manifest, 'disableAssetsAnalyze')) {
                      return manifest.disableAssetsAnalyze === true;
                    }
                  }

                  return getDefaultDisableAssetsAnalyze(cfgCommand);
                };

                disablePreload = getConfiguredDisableAssetsAnalyze(command);
              },
              generateBundle(
                _outputOptions: NormalizedOutputOptionsLike,
                bundle: BundleLike,
                _isWrite: boolean
              ) {
                if (disablePreload) return;

                for (const chunk of Object.values(bundle)) {
                  if (!isOutputChunk(chunk)) continue;
                  if (!chunk.code.includes('modulepreload')) continue;
                  const chunkDir = path.dirname(chunk.fileName);
                  const prefixToRoot =
                    chunkDir === '.'
                      ? ''
                      : `${normalizePathForImport(path.relative(chunkDir, '.'))}/`;
                  const replacementExpr = prefixToRoot
                    ? `${escapeUnsafeJsSourceChars(JSON.stringify(prefixToRoot))}+$1`
                    : '$1';
                  // Match Vite's preload helper asset URL function across minifiers:
                  //   Vite 8+:  t=function(e){return`/`+e}
                  //   esbuild (Vite 5-7): const o=e=>"/"+e  or  o=function(e){return"/"+e}
                  //   terser:             o=function(e,t){return'/'+e}
                  // Replace with import.meta.url-based resolution so assets
                  // resolve against the module's own origin, not the page origin.
                  const replacement = `=function($1){return new URL(${replacementExpr},import.meta.url).href}`;
                  // Arrow function: e=>"/"+e or (e)=>"/"+e or (e,t)=>"/"+e
                  // The string literal must start with "/" to avoid matching unrelated
                  // functions like Stencil's getScopeId: (e,t)=>"sc-"+e.$tagName$
                  const replaced = chunk.code.replace(
                    /=\s*\(?(\w+)(?:,\w+)?\)?\s*=>\s*[`"'][./][^`"']*[`"']\s*\+\s*\1/,
                    replacement
                  );
                  if (replaced !== chunk.code) {
                    chunk.code = replaced;
                    continue;
                  }
                  // Function expression: function(e){return"/"+e} (1 or 2 params)
                  chunk.code = chunk.code.replace(
                    /=\s*function\((\w+)(?:,\w+)?\)\s*\{\s*return\s*[`"'][./][^`"']*[`"']\s*\+\s*\1;?\s*\}/,
                    replacement
                  );
                  chunk.code = chunk.code.replace(
                    /=function\((\w+)(?:,\w+)?\)\{return new URL\("\.\.\/"\+\1,import\.meta\.url\)\.href\}/,
                    replacement
                  );
                  chunk.code = chunk.code.replace(
                    /new URL\("\.\.\/"\+(\w+),import\.meta\.url\)\.href/g,
                    `new URL(${replacementExpr},import.meta.url).href`
                  );
                }
              },
            } satisfies Plugin,
          ]
        : [];
    })(),
  ];
}

function createModuleFederationConfig<T extends ModuleFederationOptions>(options: T): T {
  return options;
}

export {
  createModuleFederationConfig,
  federation,
  type ModuleFederationOptions,
  type PluginExperimentsOptions,
  type PluginManifestOptions,
  type TreeShakingConfig,
};

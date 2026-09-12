import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs';
import type { Dirent } from 'fs';
import { createRequire, isBuiltin } from 'module';
import * as path from 'node:path';
import { pathToFileURL } from 'url';
import type { Plugin, ResolvedConfig, UserConfig, ViteDevServer } from 'vite';
import { normalizePathForImport } from '../utils/buildPaths';
import { findModuleImportDescriptors } from '../utils/htmlEntryUtils';
import { mfWarn } from '../utils/logger';
import {
  getNormalizeModuleFederationOptions,
  type NormalizedModuleFederationOptions,
  type NormalizedShared,
  type ShareItem,
} from '../utils/normalizeModuleFederationOptions';
import {
  getCommonSharedSubpathFromNodeModulePath,
  getMatchingNodeModuleSubpath,
  isNodeModulePath,
  isAssetLikeImport,
  normalizeNodeModulePath,
} from '../utils/pathNormalization';
import {
  findSharedKey,
  invalidateSharedKeyMatcher,
  matchesSharedSource,
} from '../utils/sharedKeyMatcher';
import {
  getIsRolldown,
  getInstalledPackageJson,
  type InstalledPackageJson,
  getInstalledPackageEntry,
  getPackageDetectionCwd,
  getPackageName,
  getPackageNameFromNodeModulePath,
  hasPackageDependency,
  setPackageDetectionCwd,
} from '../utils/packageUtils';
import { PromiseStore } from '../utils/PromiseStore';
import { getSharedExportConditions } from '../utils/sharedExportConditions';
import VirtualModule, { assertModuleFound } from '../utils/VirtualModule';
import {
  collectTreeShakingImports,
  markTreeShakingPackageUnsafe,
  recordTreeShakingExports,
  resetTreeShakingExports,
  setTreeShakingBuildMode,
  shouldAnalyzeSharedExports,
} from '../utils/treeShaking';
import {
  addConfiguredShare,
  addUsedShares,
  addTreeShakingGraphQuery,
  getConcreteSharedImportSource,
  generateLocalSharedImportMap,
  getPreBuildShareItem,
  getLoadShareModulePath,
  getLocalSharedImportMapPath,
  LOAD_SHARE_TAG,
  PREBUILD_TAG,
  refreshHostAutoInit,
  getResolvedLocalSharedImportMapId,
  getTreeShakingSharedProviderImportId,
  getTreeShakingSharedProviderName,
  getTreeShakingGraphToken,
  hasTreeShakingSharedProvider,
  getUsedShares,
  setLocalSharedImportMapInvalidator,
  writeLoadShareModule,
  writeLocalSharedImportMap,
  writePreBuildLibPath,
  refreshTreeShakingModules,
  stripTreeShakingGraphQuery,
} from '../virtualModules';

export { findSharedKey, matchesSharedSource };

function getPrebuildResolutionSource(pkgName: string, shareItem?: ShareItem): string {
  return getConcreteSharedImportSource(pkgName, shareItem) || pkgName;
}

function tryResolveFromProjectRoot(source: string): string | undefined {
  if (path.isAbsolute(source) || source.startsWith('.') || source.startsWith('/')) return source;
  const browserEntry = getInstalledPackageEntry(source, { cwd: getPackageDetectionCwd() });
  if (browserEntry) return browserEntry;
  try {
    const projectRequire = createRequire(
      pathToFileURL(path.join(getPackageDetectionCwd(), 'package.json'))
    );
    return projectRequire.resolve(source);
  } catch {
    return undefined;
  }
}

function isBuildConfigImporter(importer: string | undefined): boolean {
  if (!importer) return false;
  return /(^|\/)(?:nuxt|vite|vitest|webpack|rollup|rspack)\.config\.[cm]?[jt]sx?$/.test(
    importer.replace(/\\/g, '/')
  );
}

function findSharedKeyForSource(
  source: string,
  shared: NormalizedShared | undefined
): string | undefined {
  const key = findSharedKey(source, shared);
  if (key) return key;
  const explicitSharedSubpathKeys = Object.keys(shared || {}).filter(
    (sharedKey) => getPackageName(sharedKey) !== sharedKey && !sharedKey.endsWith('/')
  );

  if (isNodeModulePath(source)) {
    const explicitSubpathKey = getMatchingNodeModuleSubpath(source, explicitSharedSubpathKeys);
    if (explicitSubpathKey) return explicitSubpathKey;

    const normalizedSource = normalizeNodeModulePath(source);
    const explicitSubpathEntryKey = explicitSharedSubpathKeys.find((sharedKey) => {
      const entry = getInstalledPackageEntry(sharedKey, { cwd: getPackageDetectionCwd() });
      return entry ? normalizeNodeModulePath(entry) === normalizedSource : false;
    });
    if (explicitSubpathEntryKey) return explicitSubpathEntryKey;
  }

  const packageName = getPackageNameFromNodeModulePath(source);
  return packageName ? findSharedKey(packageName, shared) : undefined;
}

/**
 * Reads the dependencies of an installed package from its package.json.
 */
function getPackageDependencies(pkg: string): string[] {
  const packageName = getPackageName(pkg);
  const installed = getInstalledPackageJson(packageName, { packageName });
  return Object.keys((installed?.packageJson.dependencies as Record<string, string>) || {});
}

/**
 * In dev mode, detects shared packages that are sub-dependencies of other
 * shared packages and removes them to avoid initialization order issues.
 * For example, `lit` depends on `lit-html`, `lit-element`, and
 * `@lit/reactive-element` — sharing them separately causes the child modules
 * to load before their parent, resulting in `undefined` class extends errors.
 */
export function excludeSharedSubDependencies(shared: NormalizedShared): void {
  const sharedKeys = new Set(Object.keys(shared));
  const sharedKeyByBase = new Map(
    Object.keys(shared).map((key) => [key.endsWith('/') ? key.slice(0, -1) : key, key])
  );

  for (const parentKey of sharedKeys) {
    const deps = getPackageDependencies(parentKey);
    for (const dep of deps) {
      const depKey = sharedKeyByBase.get(dep);
      if (depKey && depKey !== parentKey) {
        if (
          shared[depKey]?.shareConfig.singleton === true ||
          shared[depKey]?.shareConfig.import === false
        ) {
          continue;
        }

        mfWarn(
          `"${dep}" is a dependency of shared package "${parentKey}" and is also shared separately. ` +
            `This may cause initialization order issues in dev mode. ` +
            `Consider sharing only "${parentKey}".\n` +
            `  Auto-excluding "${dep}" from shared modules for dev mode.`
        );
        delete shared[depKey];
        sharedKeys.delete(depKey);
        sharedKeyByBase.delete(dep);
        // A matcher cached before this deletion would keep resolving the
        // removed key and hand callers an undefined shareItem.
        invalidateSharedKeyMatcher(shared);
      }
    }
  }
}

const sharedDependencyCache = new Map<string, Set<string>>();
const sharedPackageDirectoryCache = new WeakMap<
  NormalizedShared,
  { cwd: string; entries: Map<string, string> }
>();

export function getSharedPackageFromFile(
  importer: string | undefined,
  shared: NormalizedShared,
  cwd = getPackageDetectionCwd()
): string | undefined {
  if (!importer) return;
  const nodeModulePackage = getPackageNameFromNodeModulePath(importer);
  if (nodeModulePackage) return nodeModulePackage;
  let cached = sharedPackageDirectoryCache.get(shared);
  if (!cached || cached.cwd !== cwd) {
    const entries = new Map<string, string>();
    for (const key of Object.keys(shared)) {
      const packageName = getPackageName(key);
      const entry = getInstalledPackageEntry(packageName, { cwd });
      if (entry && !isNodeModulePath(entry)) {
        entries.set(path.dirname(normalizePathForImport(entry)), packageName);
      }
    }
    cached = { cwd, entries };
    sharedPackageDirectoryCache.set(shared, cached);
  }
  const normalizedImporter = normalizePathForImport(importer);
  const sharedPackage = [...cached.entries].find(
    ([dir]) => normalizedImporter === dir || normalizedImporter.startsWith(`${dir}/`)
  )?.[1];
  // A workspace package that is not shared still takes part in package-level cycles: its files get inlined
  // into the fallback of the share that depends on it, so its import of another share must be judged
  // the same way as an import from inside `node_modules` (which resolves to a package name above).
  return sharedPackage ?? getWorkspacePackageNameFromFile(normalizedImporter);
}

const workspacePackageNameCache = new Map<string, string | undefined>();

/** Name from the nearest `package.json` above `file`, for files outside `node_modules`. */
function getWorkspacePackageNameFromFile(file: string): string | undefined {
  const filePath = file.split('?')[0];
  if (!path.isAbsolute(filePath) || isNodeModulePath(filePath)) return;
  const visited: string[] = [];
  let dir = path.dirname(filePath);
  let name: string | undefined;
  while (true) {
    if (workspacePackageNameCache.has(dir)) {
      name = workspacePackageNameCache.get(dir);
      break;
    }
    visited.push(dir);
    const manifestPath = path.join(dir, 'package.json');
    if (existsSync(manifestPath)) {
      try {
        const manifestName = (JSON.parse(readFileSync(manifestPath, 'utf-8')) as { name?: unknown })
          .name;
        if (typeof manifestName !== 'string') {
          const parent = path.dirname(dir);
          if (parent === dir) break;
          dir = parent;
          continue;
        }
        name = manifestName;
      } catch {
        name = undefined;
      }
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const visitedDir of visited) workspacePackageNameCache.set(visitedDir, name);
  return name;
}

const dependencyManifestCache = new Map<string, InstalledPackageJson | undefined>();

/**
 * The manifest of `dep` as seen from `fromDir`: a plain `node_modules` walk-up first, because the
 * cycle walk below visits every package in the tree and `getInstalledPackageJson`'s resolver is
 * far too expensive for that many lookups; it stays the fallback for layouts the walk-up misses.
 */
function getDependencyManifest(dep: string, fromDir: string): InstalledPackageJson | undefined {
  const cacheKey = `${fromDir}\0${dep}`;
  if (dependencyManifestCache.has(cacheKey)) return dependencyManifestCache.get(cacheKey);
  let found: InstalledPackageJson | undefined;
  let currentDir = fromDir;
  while (true) {
    const packageJsonPath = path.join(currentDir, 'node_modules', dep, 'package.json');
    if (existsSync(packageJsonPath)) {
      try {
        let dir = path.dirname(packageJsonPath);
        try {
          dir = realpathSync(dir);
        } catch {
          // Keep the symlink path when it cannot be resolved.
        }
        found = {
          path: packageJsonPath,
          dir,
          packageJson: JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as Record<
            string,
            unknown
          >,
        };
      } catch {
        // Unreadable manifest: fall through to the resolver below.
      }
      break;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }
  found ??= getInstalledPackageJson(dep, { cwd: fromDir, packageName: dep });
  dependencyManifestCache.set(cacheKey, found);
  return found;
}

/** Whether `dependency` is reachable through the shared package's manifest dependencies. */
export function isSharedPackageDependency(sharedKey: string, dependency: string) {
  const sharedPackage = getPackageName(sharedKey);
  let reachable = sharedDependencyCache.get(sharedPackage);
  if (!reachable) {
    reachable = new Set<string>();
    const visited = new Set<string>();
    const queue = [getInstalledPackageJson(sharedPackage, { packageName: sharedPackage })];
    // An unresolvable dependency (an uninstalled optional peer, say) must not end the walk early.
    while (queue.length) {
      const installed = queue.shift();
      if (!installed || visited.has(installed.dir)) continue;
      visited.add(installed.dir);
      const manifest = installed.packageJson as Record<string, Record<string, string> | undefined>;
      for (const dep of Object.keys({
        ...manifest.dependencies,
        ...manifest.peerDependencies,
        ...manifest.optionalDependencies,
      })) {
        reachable.add(dep);
        queue.push(getDependencyManifest(dep, installed.dir));
      }
    }
    sharedDependencyCache.set(sharedPackage, reachable);
  }
  return reachable.has(dependency);
}

function isConfiguredSharedPackage(pkg: string, shared: NormalizedShared): boolean {
  return Object.keys(shared).some((key) => getPackageName(key) === pkg);
}

function shouldKeepSharedImportLocal(
  source: string,
  importer: string | undefined,
  sharedKey: string,
  shared: NormalizedShared,
  importerPackage?: string
): boolean {
  if (!importer || shared[sharedKey]?.shareConfig.import === false) return false;

  const prebuildImporter = importer.includes(PREBUILD_TAG)
    ? VirtualModule.findModule(PREBUILD_TAG, importer)
    : undefined;
  const fallbackPackage = prebuildImporter
    ? getPackageName(prebuildImporter.name)
    : importerPackage;
  if (!fallbackPackage || !isConfiguredSharedPackage(fallbackPackage, shared)) return false;

  const sourcePackage = getPackageName(sharedKey);
  // Patch-skew #527 is a react-dom fallback evaluating against a different
  // react instance. Workspace shared packages (UI kits, routers, …) that
  // merely peer-depend on react must stay on loadShare — resolving them to
  // the raw CJS entry makes Vite DEV serve /@fs/.../jsx-runtime.js without
  // named `jsx` exports (gioboa react example).
  if (fallbackPackage !== 'react-dom' || sourcePackage !== 'react') return false;
  if (prebuildImporter && matchesSharedSource(source, prebuildImporter.name)) return false;

  const dependencyRoot = prebuildImporter?.name ?? fallbackPackage;
  if (!isSharedPackageDependency(dependencyRoot, sourcePackage)) return false;
  if (isSharedPackageDependency(sharedKey, fallbackPackage)) return false;

  return true;
}

const sharedRuntimeDependencyCache = new Map<
  string,
  { dependencies: Set<string>; complete: boolean }
>();
const SOURCE_FILE_RE = /\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/;
const NON_RUNTIME_SOURCE_RE = /(?:\.d\.[cm]?ts|\.(?:test|spec|stories)\.[cm]?[jt]sx?)$/;
const NON_RUNTIME_DIRS = new Set(['node_modules', '__tests__', 'dist', 'build']);
/** Keep local runtime walks bounded without skipping the package entry itself. */
const MAX_SCANNED_SOURCE_BYTES = 256 * 1024;

const BARE_PACKAGE_SPECIFIER_RE =
  /^(?:@[^\s'"`()\/]+\/)?[^\s'"`()\/.@][^\s'"`()\/]*(?:\/[^\s'"`()]*)?$/;

/** Module specifiers evaluated by a source file. */
function getRuntimeModuleSpecifiers(code: string): string[] {
  return findModuleImportDescriptors(code)
    .filter(({ typeOnly }) => !typeOnly)
    .map(({ source }) => source);
}

/** Bare specifiers a source file imports at runtime. */
export function getRuntimeImportSpecifiers(code: string): string[] {
  return getRuntimeModuleSpecifiers(code).filter(
    (specifier) => BARE_PACKAGE_SPECIFIER_RE.test(specifier) && !isBuiltin(specifier)
  );
}

function collectAllRuntimeImports(dir: string, into: Set<string>): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  let complete = true;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (
        !NON_RUNTIME_DIRS.has(entry.name) &&
        !collectAllRuntimeImports(path.join(dir, entry.name), into)
      ) {
        complete = false;
      }
      continue;
    }
    if (!SOURCE_FILE_RE.test(entry.name) || NON_RUNTIME_SOURCE_RE.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    let code: string;
    try {
      if (statSync(file).size > MAX_SCANNED_SOURCE_BYTES) {
        complete = false;
        continue;
      }
      code = readFileSync(file, 'utf-8');
    } catch {
      complete = false;
      continue;
    }
    for (const specifier of getRuntimeImportSpecifiers(code)) into.add(specifier);
  }
  return complete;
}

const SOURCE_EXTENSIONS = ['', '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx'];

function resolveLocalRuntimeImport(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return;
  const resolved = path.resolve(path.dirname(importer), specifier);
  const candidates = SOURCE_EXTENSIONS.flatMap((extension) => [
    `${resolved}${extension}`,
    path.join(resolved, `index${extension}`),
  ]);
  // `./components` names a directory that exists, but only its index file can be scanned.
  return candidates.find((candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function collectReachableRuntimeImports(entry: string, dir: string, into: Set<string>): boolean {
  const visited = new Set<string>();
  const queue = [{ file: entry, isEntry: true }];
  let scanned = false;
  let complete = true;
  while (queue.length) {
    const { file, isEntry } = queue.shift()!;
    const relative = path.relative(dir, file);
    if (relative.startsWith('..') || path.isAbsolute(relative) || visited.has(file)) continue;
    visited.add(file);
    let code: string;
    try {
      // The package entry must be scanned even when it is a large bundled file:
      // its direct imports are the only evidence available for detecting a cycle
      // back into an unshared workspace package. Keep the limit for files reached
      // through local imports so one large bundle cannot make the whole walk expensive.
      if (!isEntry && statSync(file).size > MAX_SCANNED_SOURCE_BYTES) {
        complete = false;
        continue;
      }
      code = readFileSync(file, 'utf-8');
      scanned = true;
    } catch {
      complete = false;
      continue;
    }
    for (const specifier of getRuntimeModuleSpecifiers(code)) {
      if (BARE_PACKAGE_SPECIFIER_RE.test(specifier) && !isBuiltin(specifier)) {
        into.add(specifier);
        continue;
      }
      const local = resolveLocalRuntimeImport(file, specifier);
      if (local) queue.push({ file: local, isEntry: false });
    }
  }
  return scanned && complete;
}

/**
 * Whether `dependency` is reachable from the shared package through the imports its source files
 * (and those of the workspace packages they pull in) actually evaluate. Unlike the manifest walk
 * above this ignores `import type` edges and stops at `node_modules` boundaries, so it approximates
 * the fallback's evaluation graph rather than the package's declared closure — in a monorepo the
 * latter covers far more than the module graph ever does.
 */
export function isSharedPackageRuntimeDependency(
  sharedKey: string,
  dependency: string,
  conditions?: readonly string[]
): boolean {
  const sharedPackage = getPackageName(sharedKey);
  const cacheKey = `${sharedKey}\0${JSON.stringify(conditions ?? null)}`;
  let result = sharedRuntimeDependencyCache.get(cacheKey);
  if (!result) {
    const reachable = new Set<string>();
    let complete = true;
    const visited = new Set<string>();
    const queue = [
      {
        request: sharedKey,
        installed: getInstalledPackageJson(sharedPackage, { packageName: sharedPackage }),
      },
    ];
    while (queue.length) {
      const { request, installed } = queue.shift()!;
      if (!installed) {
        complete = false;
        continue;
      }
      const visitKey = `${installed.dir}\0${request}`;
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);
      const specifiers = new Set<string>();
      const entry = getInstalledPackageEntry(request, {
        cwd: installed.dir,
        packageName: getPackageName(request),
        resolveSubpathWithRequire: false,
        ...(conditions !== undefined ? { conditions: [...conditions] } : {}),
      });
      if (!entry) {
        if (!collectAllRuntimeImports(installed.dir, specifiers)) complete = false;
      } else if (!collectReachableRuntimeImports(entry, installed.dir, specifiers)) {
        complete = false;
        collectAllRuntimeImports(installed.dir, specifiers);
      }
      for (const specifier of specifiers) {
        const dep = getPackageName(specifier);
        if (dep === sharedPackage) continue;
        reachable.add(dep);
        const manifest = getDependencyManifest(dep, installed.dir);
        // Only workspace packages get bundled into the fallback; a node_modules package stays a leaf.
        if (manifest && !isNodeModulePath(manifest.dir)) {
          queue.push({ request: specifier, installed: manifest });
        }
      }
    }
    result = { dependencies: reachable, complete };
    sharedRuntimeDependencyCache.set(cacheKey, result);
  }
  return (
    result.dependencies.has(dependency) ||
    (!result.complete && isSharedPackageDependency(sharedKey, dependency))
  );
}

export function proxySharedModule(options: {
  shared?: NormalizedShared;
  federationOptions?: NormalizedModuleFederationOptions;
  getParsePromise?: () => Promise<unknown>;
}): Plugin[] {
  const { shared = {}, federationOptions, getParsePromise = () => Promise.resolve() } = options;
  let _config: ResolvedConfig | undefined;
  let _command = 'serve';
  let useDirectReactImport = false;
  let useRolldown = false;
  let isProduction = false;
  let rootResolveConditions: string[] | undefined;
  let ssrResolveConditions: string[] | undefined;
  let ssrTarget: 'node' | 'webworker' = 'node';
  const savePrebuild = new PromiseStore<string>();
  let devServer: ViteDevServer | undefined;
  // resolveId fires once per importing module. The loadShare virtual module,
  // prebuild path, import map, and host-auto-init are a pure function of the
  // shared source, so regenerating them on every resolution is redundant — a
  // singleton imported by N modules would rewrite all of it N times. Track which
  // sources have been materialized so the heavy writes happen at most once each.
  const materializedLoadShareSources = new Set<string>();
  const emittedTreeShakingProviders = new Set<string>();
  const hasAnalyzableShares = Object.values(shared).some((share) =>
    shouldAnalyzeSharedExports(share)
  );
  type RuntimeDependencyContext = {
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
  const getEnvironmentConfig = (context: unknown) =>
    (context as RuntimeDependencyContext).environment?.config;
  const getEnvironmentConditions = (context: unknown): string[] | undefined =>
    getEnvironmentConfig(context)?.resolve?.conditions;
  const getRuntimeDependencyConditions = (
    context: unknown,
    resolveOptions: { ssr?: boolean }
  ): string[] => {
    const environment = (context as RuntimeDependencyContext).environment;
    const environmentConfig = environment?.config;
    const isSsr =
      resolveOptions.ssr === true ||
      Boolean(_config?.build?.ssr) ||
      environmentConfig?.consumer === 'server' ||
      Boolean(environmentConfig?.build?.ssr) ||
      environment?.name === 'ssr' ||
      environment?.name === 'server';
    return getSharedExportConditions({
      environmentConditions: environmentConfig?.resolve?.conditions,
      isProduction: environmentConfig?.isProduction ?? isProduction,
      isSsr,
      rootConditions: rootResolveConditions,
      ssrConditions: ssrResolveConditions,
      ssrTarget,
    });
  };
  const refreshTreeShakingForEnvironment = (context: unknown) =>
    refreshTreeShakingModules(
      federationOptions,
      _command,
      getIsRolldown(context),
      getEnvironmentConditions(context)
    );

  const normalizeTreeShakingOutputPath = (value: string) => {
    const normalized = normalizePathForImport(value);
    if (
      path.posix.isAbsolute(normalized) ||
      /^[A-Za-z]:\//.test(normalized) ||
      normalized.split('/').includes('..')
    ) {
      throw new Error(
        `Invalid treeShakingDir "${value}": absolute paths and parent segments are not allowed.`
      );
    }
    let start = normalized.startsWith('./') ? 2 : 0;
    let end = normalized.length;
    while (start < end && normalized.charCodeAt(start) === 47) start++;
    while (end > start && normalized.charCodeAt(end - 1) === 47) end--;
    return normalized.slice(start, end);
  };

  const getTreeShakingProviderFileName = (pkg: string, shareItem: ShareItem) => {
    const treeShaking = shareItem.shareConfig.treeShaking;
    if (!treeShaking) return undefined;

    const normalizedOptions = federationOptions ?? getNormalizeModuleFederationOptions();
    const outputDir = normalizedOptions.treeShakingDir
      ? normalizeTreeShakingOutputPath(normalizedOptions.treeShakingDir)
      : undefined;

    const fileName = outputDir
      ? path.posix.join(outputDir, `${getTreeShakingSharedProviderName(pkg, federationOptions)}.js`)
      : undefined;

    if (!fileName) return undefined;
    return fileName;
  };

  const emitTreeShakingProvider = (
    context: { emitFile: (file: any) => string },
    pkg: string,
    shareItem: ShareItem
  ) => {
    if (_command !== 'build' || emittedTreeShakingProviders.has(pkg)) return;
    if (!hasTreeShakingSharedProvider(pkg, shareItem, federationOptions)) return;

    const fileName = getTreeShakingProviderFileName(pkg, shareItem);
    context.emitFile({
      type: 'chunk',
      id: getTreeShakingSharedProviderImportId(pkg, federationOptions),
      name: getTreeShakingSharedProviderName(pkg, federationOptions),
      ...(fileName ? { fileName } : {}),
    });
    emittedTreeShakingProviders.add(pkg);
  };

  return [
    {
      name: 'generateLocalSharedImportMap',
      enforce: 'post',
      configureServer(server) {
        devServer = server;
        setLocalSharedImportMapInvalidator(() => {
          const module = server.moduleGraph.getModuleById(
            getResolvedLocalSharedImportMapId(federationOptions)
          );
          if (module) server.moduleGraph.invalidateModule(module);
        }, federationOptions);
      },
      resolveId(source) {
        if (source === getLocalSharedImportMapPath(federationOptions)) {
          return getResolvedLocalSharedImportMapId(federationOptions);
        }
      },
      load(id) {
        if (id === getResolvedLocalSharedImportMapId(federationOptions)) {
          return getParsePromise().then((_) => {
            // Export analysis is additive across the module graph. Materialize
            // and emit optimized providers only when the shared map itself is
            // finalized, immediately before Rollup discovers their imports.
            refreshTreeShakingForEnvironment(this);
            const providerPackages = new Set([
              ...Object.keys(shared).filter((pkg) => !pkg.endsWith('/')),
              ...getUsedShares(federationOptions),
            ]);
            for (const pkg of providerPackages) {
              const sharedKey = findSharedKeyForSource(pkg, shared);
              const shareItem = shared[pkg] || (sharedKey ? shared[sharedKey] : undefined);
              if (shareItem) emitTreeShakingProvider(this, pkg, shareItem);
            }
            return generateLocalSharedImportMap(federationOptions);
          });
        }
      },
      closeBundle() {
        if (devServer) return;
        setLocalSharedImportMapInvalidator(undefined, federationOptions);
      },
    },
    {
      name: 'proxyPreBuildShared',
      enforce: 'post',
      config(config: UserConfig, { command }) {
        const root = config.root || process.cwd();
        setPackageDetectionCwd(root);
        setTreeShakingBuildMode(command === 'build', federationOptions);
        resetTreeShakingExports(federationOptions);
        emittedTreeShakingProviders.clear();
        sharedDependencyCache.clear();
        dependencyManifestCache.clear();
        sharedRuntimeDependencyCache.clear();
        workspacePackageNameCache.clear();
        const isVinext = hasPackageDependency('vinext');
        const isAstro = hasPackageDependency('astro');
        const isRolldown = getIsRolldown(this);
        _command = command;
        useRolldown = isRolldown;
        useDirectReactImport = isVinext || isAstro;
        if (command === 'serve') {
          excludeSharedSubDependencies(shared);
        }
      },
      configResolved(config) {
        _config = config;
        isProduction = config.isProduction;
        rootResolveConditions = config.resolve?.conditions
          ? [...config.resolve.conditions]
          : undefined;
        ssrResolveConditions = config.ssr?.resolve?.conditions
          ? [...config.ssr.resolve.conditions]
          : undefined;
        ssrTarget = config.ssr?.target ?? 'node';

        // Write virtual module files and register provider metadata eagerly.
        // Materialization stays tied to imports observed by resolveId below.
        // The deadlock that previously occurred here (localSharedImportMap
        // referencing prebuild modules → Vite re-optimization → deadlock)
        // is now prevented by adding prebuild IDs to optimizeDeps.include
        // in the config hook (createEarlyVirtualModulesPlugin), so Vite
        // pre-bundles them upfront without triggering re-optimization.
        const isRolldown = getIsRolldown(this);
        const resolvedOptions = federationOptions ?? getNormalizeModuleFederationOptions();
        const registerConfiguredShare =
          _command === 'build' && Object.keys(resolvedOptions.exposes).length > 0
            ? addUsedShares
            : addConfiguredShare;
        Object.keys(shared).forEach((key) => {
          if (key.endsWith('/')) return;
          if (useDirectReactImport && key === 'react') {
            registerConfiguredShare(key, federationOptions);
            return;
          }
          writeLoadShareModule(key, shared[key], _command, isRolldown, federationOptions);
          // Skip prebuild for shared deps with import: false — the host must
          // provide them, so no local fallback source is needed.
          if (shared[key].shareConfig.import !== false) {
            writePreBuildLibPath(key, shared[key], federationOptions);
          }
          registerConfiguredShare(key, federationOptions);
        });
        writeLocalSharedImportMap(federationOptions);
        refreshHostAutoInit(federationOptions);
      },
      buildStart() {
        if (_command !== 'build') return;
        resetTreeShakingExports(federationOptions);
        emittedTreeShakingProviders.clear();
        refreshTreeShakingForEnvironment(this);
      },
      shouldTransformCachedModule() {
        // Watch builds must revisit cached importers after the per-build usage
        // map is reset, otherwise only changed files contribute usedExports.
        return _command === 'build' && hasAnalyzableShares;
      },
      transform(code, id) {
        if (_command !== 'build' || !hasAnalyzableShares) {
          return;
        }
        collectTreeShakingImports(
          code,
          id,
          shared,
          findSharedKeyForSource,
          (sharedKey, exports, request) =>
            recordTreeShakingExports(sharedKey, exports, request, federationOptions),
          (sharedKey, request) =>
            markTreeShakingPackageUnsafe(sharedKey, request, federationOptions)
        );
        refreshTreeShakingForEnvironment(this);
      },
    },
    {
      name: 'proxyPreBuildShared:tree-shaking-graph',
      enforce: 'pre',
      apply: 'build',
      async resolveId(source, importer, resolveOptions) {
        const sourceToken = getTreeShakingGraphToken(source);
        const importerToken = getTreeShakingGraphToken(importer);
        const token = sourceToken || importerToken;
        if (!token) return;

        const cleanSource = normalizePathForImport(stripTreeShakingGraphQuery(source));
        const cleanImporter = importer
          ? normalizePathForImport(stripTreeShakingGraphQuery(importer))
          : undefined;

        // Dependencies that are independently configured as shared keep using
        // their ordinary federation wrapper. Everything else inherits the
        // graph token so the optimized provider cannot be merged with the full
        // fallback's dependency graph.
        if (!sourceToken && importerToken) {
          const nestedSharedKey = findSharedKeyForSource(cleanSource, shared);
          if (
            nestedSharedKey &&
            getPackageName(nestedSharedKey) !== getPackageName(importerToken)
          ) {
            return this.resolve(cleanSource, cleanImporter, {
              ...resolveOptions,
              skipSelf: true,
            });
          }
        }

        const projectResolvedSource = sourceToken
          ? tryResolveFromProjectRoot(cleanSource) || cleanSource
          : cleanSource;
        const resolved = await this.resolve(projectResolvedSource, cleanImporter, {
          ...resolveOptions,
          custom: {
            ...resolveOptions.custom,
            __mfTreeShakingGraph: true,
          },
          skipSelf: true,
        });
        if (!resolved || resolved.external) return resolved;
        // Bundler/plugin virtual modules generally require an exact id in their
        // load hook (for example Vite's preload helper). Appending an unknown
        // query would make them unloadable; their own implementation is build
        // infrastructure rather than part of the shared package graph.
        if (resolved.id.startsWith('\0')) return resolved;

        return {
          ...resolved,
          id: addTreeShakingGraphQuery(normalizePathForImport(resolved.id), token),
        };
      },
    },
    {
      name: 'proxyPreBuildShared:resolve-shared-loadShare',
      enforce: 'pre',
      async resolveId(source, importer, resolveOptions) {
        if ((resolveOptions.custom as Record<string, unknown> | undefined)?.__mfTreeShakingGraph) {
          return;
        }
        function shouldSkipTaggedImporterProxy(sharedKey: string, tag: string): boolean {
          if (!importer?.includes(tag)) return false;

          const taggedModule = VirtualModule.findModule(tag, importer);
          if (!taggedModule) return true;

          // Only skip a wrapper's own fallback import. Cross-wrapper shared imports
          // still need proxying, e.g. @fortawesome/vue-fontawesome -> vue.
          return taggedModule.name === sharedKey || matchesSharedSource(source, taggedModule.name);
        }

        const key = findSharedKeyForSource(source, shared);
        if (!key) return;
        // A shared package's own files must keep ordinary internal module edges.
        // Compare package roots because `key` may be an explicit subpath or a
        // trailing-slash wildcard share key.
        const importerPackage = getSharedPackageFromFile(importer, shared);
        if (importerPackage === getPackageName(key)) return;
        // A dependency of the shared package that imports it back (a package-level
        // cycle) keeps its ordinary edge too. Proxying it would place the loadShare
        // glue inside the package's own evaluation cycle, where the glue's eager
        // export reads run before the fallback body has initialized.
        // An unshared workspace importer is judged by the imports the shared package
        // evaluates, not by its manifest closure: in a monorepo that closure reaches
        // most of the workspace through type-only dependencies, and an ordinary edge
        // there binds the importer to the local fallback even when a host provides
        // the singleton.
        if (importerPackage) {
          const importerIsUnsharedWorkspacePackage =
            !isNodeModulePath(importer!) &&
            !Object.keys(shared).some((sharedKey) => getPackageName(sharedKey) === importerPackage);
          const runtimeDependencyRequest =
            key.endsWith('/') && matchesSharedSource(source, key) ? source : key;
          const keepsOrdinaryEdge = importerIsUnsharedWorkspacePackage
            ? isSharedPackageRuntimeDependency(
                runtimeDependencyRequest,
                importerPackage,
                getRuntimeDependencyConditions(this, resolveOptions)
              )
            : isSharedPackageDependency(key, importerPackage);
          if (keepsOrdinaryEdge) return;
        }
        if (useDirectReactImport && key === 'react') return;
        if (isAssetLikeImport(source)) return;
        if (isBuildConfigImporter(importer)) return;
        // Hard-stop proxying bare React in dev. Vite's RSC pipeline expects
        // the native server React entry.
        if (useDirectReactImport && source === 'react') return;
        // Avoid recursive loadShare/prebuild/local map resolution loops.
        if (importer && importer.includes('localSharedImportMap')) return;
        if (importer && (importer.includes('hostAutoInit') || importer.includes('__H_A_I__'))) {
          return;
        }
        if (shouldSkipTaggedImporterProxy(key, LOAD_SHARE_TAG)) return;
        if (shouldSkipTaggedImporterProxy(key, PREBUILD_TAG)) return;
        const shareSource =
          key === 'vue' && source.startsWith('vue/dist/')
            ? key
            : isNodeModulePath(source)
              ? getCommonSharedSubpathFromNodeModulePath(source, key) || key
              : source;
        if (shouldKeepSharedImportLocal(source, importer, key, shared, importerPackage)) {
          const localSource = getPrebuildResolutionSource(shareSource, shared[key]);
          // A sibling prebuild would re-enter Vite's CommonJS proxy on Vite 5–7.
          return tryResolveFromProjectRoot(localSource) || localSource;
        }
        const loadSharePath = getLoadShareModulePath(shareSource, useRolldown, federationOptions);
        if (!materializedLoadShareSources.has(shareSource)) {
          materializedLoadShareSources.add(shareSource);
          writeLoadShareModule(shareSource, shared[key], _command, useRolldown, federationOptions);
          if (shared[key].shareConfig.import !== false) {
            writePreBuildLibPath(shareSource, shared[key], federationOptions);
          }
          addUsedShares(shareSource, federationOptions);
          writeLocalSharedImportMap(federationOptions);
          refreshHostAutoInit(federationOptions);
        }
        return this.resolve(loadSharePath, importer, { skipSelf: true });
      },
    },
    {
      name: 'proxyPreBuildShared:resolve-prebuild',
      enforce: 'pre',
      async resolveId(source, importer) {
        if (!source.includes(PREBUILD_TAG)) return;
        if (source.startsWith('.')) return;

        const module = assertModuleFound(PREBUILD_TAG, source) as VirtualModule;
        const pkgName = module.name;
        const importSource = getPrebuildResolutionSource(
          pkgName,
          getPreBuildShareItem(pkgName, federationOptions)
        );

        if (_command === 'build') {
          return this.resolve(importSource, importer, { skipSelf: true });
        }

        const direct = tryResolveFromProjectRoot(importSource);
        const directSource = direct && !isNodeModulePath(direct) ? direct : undefined;
        const resolved = await this.resolve(directSource || importSource, importer, {
          skipSelf: true,
        });
        if (!resolved?.id) return;
        const result = resolved.id;
        if (!_config || result.includes(_config.cacheDir)) {
          if (directSource) {
            return (
              (await this.resolve(directSource, importer, { skipSelf: true })) || {
                id: directSource,
              }
            );
          }
          return resolved;
        }
        // save pre-bunding module id
        savePrebuild.set(pkgName, Promise.resolve(result));
        // Fix localSharedImportMap import id
        return await this.resolve(await savePrebuild.get(pkgName), importer, { skipSelf: true });
      },
    },
  ];
}

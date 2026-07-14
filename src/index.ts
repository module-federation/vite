import { readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import * as path from 'node:path';
import { pathToFileURL } from 'url';
import type { ConfigEnv, EnvironmentOptions, Plugin, ResolvedConfig, UserConfig } from 'vite';
import { version as viteVersion } from 'vite';
import addEntry from './plugins/pluginAddEntry';
import { checkAliasConflicts } from './plugins/pluginCheckAliasConflicts';
import pluginDevRemoteHmr, { shouldIgnoreFile } from './plugins/pluginDevRemoteHmr';
import pluginManifest from './plugins/pluginMFManifest';
import pluginModuleParseEnd from './plugins/pluginModuleParseEnd';
import pluginProxyRemoteEntry from './plugins/pluginProxyRemoteEntry';
import pluginProxyRemotes from './plugins/pluginProxyRemotes';
import { findSharedKey, proxySharedModule } from './plugins/pluginProxySharedModule_preBuild';
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
import type {
  ModuleFederationOptions,
  NormalizedModuleFederationOptions,
  PluginManifestOptions,
  ShareItem,
  TreeShakingConfig,
} from './utils/normalizeModuleFederationOptions';
import { normalizeModuleFederationOptions } from './utils/normalizeModuleFederationOptions';
import normalizeOptimizeDepsPlugin from './utils/normalizeOptimizeDeps';
import {
  getIsRolldown,
  hasPackageDependency,
  resolveImportPath,
  setPackageDetectionCwd,
} from './utils/packageUtils';
import { getSsrCapabilities } from './utils/ssrCapabilities';
import { getCommonSharedSubpaths, isAssetLikeImport } from './utils/pathNormalization';
import VirtualModule, { createViteEncodedIdPrefixRegExp } from './utils/VirtualModule';
import {
  getHostAutoInitImportId,
  getHostAutoInitPath,
  getLocalSharedImportMapPath,
  getRemoteEntryId,
  initVirtualModules,
  LOAD_REMOTE_TAG,
  LOAD_SHARE_TAG,
  PREBUILD_TAG,
  TREE_SHAKING_GRAPH_QUERY,
  TREE_SHAKING_PROVIDER_TAG,
  setSsrRemotes,
  writeLocalSharedImportMap,
} from './virtualModules';
import { getVirtualExposesId } from './virtualModules/virtualExposes';
import { addUsedShares } from './virtualModules/virtualRemoteEntry';
import { addUsedRemote } from './virtualModules/virtualRemotes';
import { virtualRuntimeInitStatus } from './virtualModules/virtualRuntimeInitStatus';
import {
  getLoadShareModulePath,
  materializeCachedLoadShareModule,
  prependWorkspaceSingletonSsrImport,
  toViteOptimizedDepVirtualId,
  writeLoadShareModule,
  writePreBuildLibPath,
} from './virtualModules/virtualShared_preBuild';

const patchedManualChunks = new WeakSet<Function>();

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

// Returns false for subpaths not exported by the installed package (e.g.
// react/compiler-runtime on React 18) so we can exclude them from Vite's dep
// optimizer instead of letting Vite's resolver error on the missing export.
function canResolveSharedSubpath(subpath: string, projectRoot: string): boolean {
  try {
    const req = createRequire(pathToFileURL(path.join(projectRoot, 'package.json')));
    req.resolve(subpath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Plugin that runs FIRST to register generated virtual modules in the config hook.
 * This prevents 504 "Outdated Optimize Dep" errors by ensuring ids are known
 * before Vite's optimization phase.
 */
function createEarlyVirtualModulesPlugin(options: NormalizedModuleFederationOptions): Plugin {
  const { shared, remotes } = options;
  const isLitShare = (pkg: string) => pkg === 'lit' || pkg.startsWith('lit/');

  return {
    name: 'vite:module-federation-early-init',
    enforce: 'pre',
    config(config: UserConfig, { command: _command }) {
      if (_command === 'serve') ignoreFederationGeneratedFiles(config, options);

      const root = config.root || process.cwd();
      setPackageDetectionCwd(root);
      const isVinext = hasPackageDependency('vinext');

      // Configure SSR runtime with the host's remotes so server-side loadRemote
      // knows the entry URL for each remote when ssrEntryLoader intercepts it.
      setSsrRemotes(
        Object.entries(options.remotes).map(([key, r]) => ({
          name: key,
          entry: r.entry,
          type: r.type ?? 'module',
        }))
      );

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

      // Create shared module virtual files EARLY and register shares eagerly
      // so localSharedImportMap has content on first load in both serve/build.
      if (shared && Object.keys(shared).length > 0) {
        if (_command === 'serve') {
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
                if (id !== 'module-federation:optimized-require-react') return;
                const loadSharePath = getLoadShareModulePath('react', isRolldown);
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
                if (isAssetLikeImport(source)) return;
                const shareItem = shared[key];
                const isReactSingleton =
                  source === 'react' &&
                  key === 'react' &&
                  shareItem.shareConfig?.singleton === true;
                const isReactRequire =
                  resolveOptions?.kind?.startsWith('require') && isReactSingleton;
                if (resolveOptions?.kind?.startsWith('require') && !isReactSingleton) return;
                if (isCommonJsImporter(importer) && !isReactSingleton) return;
                if (isReactRequire) {
                  writeLoadShareModule(source, shareItem, _command, isRolldown);
                  if (shareItem.shareConfig?.import !== false) {
                    writePreBuildLibPath(source, shareItem);
                  }
                  addUsedShares(source, options);
                  return { id: 'module-federation:optimized-require-react' };
                }
                const loadSharePath = getLoadShareModulePath(source, isRolldown);
                writeLoadShareModule(source, shareItem, _command, isRolldown);
                if (shareItem.shareConfig?.import !== false) {
                  writePreBuildLibPath(source, shareItem);
                }
                addUsedShares(source, options);
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
                  return { path: args.path, namespace: 'mf-shared' };
                });
                build.onLoad({ filter: /.*/, namespace: 'mf-shared' }, (args: any) => {
                  const key = findSharedKey(args.path, shared);
                  if (!key) return;
                  const shareItem = shared[key];
                  const loadSharePath = getLoadShareModulePath(args.path, isRolldown);
                  const optimizedLoadSharePath = toViteOptimizedDepVirtualId(loadSharePath);
                  writeLoadShareModule(args.path, shareItem, _command, isRolldown);
                  if (shareItem.shareConfig?.import !== false) {
                    writePreBuildLibPath(args.path, shareItem);
                  }
                  addUsedShares(args.path, options);
                  return {
                    loader: 'js',
                    resolveDir: root,
                    contents: `import * as __mfShared from ${JSON.stringify(optimizedLoadSharePath)};
export * from ${JSON.stringify(optimizedLoadSharePath)};
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
                writePreBuildLibPath(subpath, shareItem);
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
            addUsedShares(key, options);
            continue;
          }
          getLoadShareModulePath(key, isRolldown);
          writeLoadShareModule(key, shareItem, _command, isRolldown);
          // Skip prebuild for shared deps with import: false — the host must
          // provide them, so no local fallback source is needed.
          if (shareItem.shareConfig?.import !== false) {
            writePreBuildLibPath(key, shareItem);
          }
          addUsedShares(key, options);
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
            const shouldBypassOptimizeDep = isLitShare(key);
            if (optimizeDeps.include.includes(key)) {
              optimizeDeps.exclude = optimizeDeps.exclude.filter((dep) => dep !== key);
            } else if (shouldBypassOptimizeDep) {
              optimizeDeps.exclude.push(key);
            } else {
              optimizeDeps.include.push(key);
            }
            for (const subpath of getCommonSharedSubpaths(key)) {
              getLoadShareModulePath(subpath, isRolldown);
              writeLoadShareModule(subpath, shareItem, _command, isRolldown);
              writePreBuildLibPath(subpath, shareItem);
              addUsedShares(subpath, options);
              if (canResolveSharedSubpath(subpath, root)) {
                optimizeDeps.include.push(subpath);
              } else {
                optimizeDeps.exclude.push(subpath);
              }
            }
          }
        }
        writeLocalSharedImportMap(options);
      }
    },

    configResolved(config) {
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
        return specifier === '@module-federation/vite/ssrEntryLoader';
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
      const ssrEntryLoaderSpecifier = '@module-federation/vite/ssrEntryLoader';
      try {
        resolveImportPath(ssrEntryLoaderSpecifier);
        options.runtimePlugins.push([ssrEntryLoaderSpecifier, { resolvedShared }]);
      } catch {
        // lib/ not built yet — skip silently
      }
    },
  };
}

const SSR_ONLY_PLUGINS = new Set(['@module-federation/vite/ssrEntryLoader']);

function loadPluginDts(options: NormalizedModuleFederationOptions): any[] {
  if (options.dts === false) {
    return [];
  }

  return [import('./plugins/pluginDts').then(({ default: pluginDts }) => pluginDts(options))];
}

function federation(mfUserOptions: ModuleFederationOptions): any[] {
  if (isTestEnv()) return [];
  const options = normalizeModuleFederationOptions(mfUserOptions);

  const isVinext = hasPackageDependency('vinext');
  const { name, shared, filename, hostInitInjectLocation } = options;
  const hasTreeShakingShared = Object.values(shared).some(
    (share) => !!share.shareConfig.treeShaking
  );
  if (!name) throw createModuleFederationError('name is required');

  const remoteEntryId = getRemoteEntryId(options);
  const virtualExposesId = getVirtualExposesId(options);

  let command: string;
  let desiredRolldownOutput: OutputNameOptions[] | undefined;
  let isSsrBuild = false;

  return [
    {
      name: 'vite:module-federation-virtual-modules',
      enforce: 'pre',
      resolveId(id: string) {
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
          });
          virtualModule = VirtualModule.findById(id);
        }
        if (!virtualModule) return;
        return virtualModule.getResolvedId();
      },
      load(id: string) {
        const virtualModule = VirtualModule.findById(id);
        if (!virtualModule) return;
        if (command === 'build' && (id.includes(LOAD_SHARE_TAG) || id.includes(LOAD_REMOTE_TAG))) {
          return;
        }
        return virtualModule.code;
      },
    },
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
      configResolved() {
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
    pluginProxyRemoteEntry({ options, remoteEntryId, virtualExposesId }),
    pluginProxyRemotes(options),
    pluginRemoteNamedExports(options),
    ...pluginModuleParseEnd(
      (id: string) => {
        return (
          id.includes(getHostAutoInitImportId(options)) ||
          id.includes(remoteEntryId) ||
          id.includes(virtualExposesId) ||
          id.includes(getLocalSharedImportMapPath(options)) ||
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
      }
    ),
    ...proxySharedModule({
      shared,
      federationOptions: options,
    }),
    {
      name: 'module-federation-esm-shims',
      enforce: 'pre',
      apply: 'build',
      config(config: UserConfig) {
        isSsrBuild = config.build?.ssr === true;
        // Force loadShare modules and runtimeInitStatus into separate chunks.
        //
        // For Vite 8+: loadShare chunks need separate async init barriers
        // so the generateBundle hook can patch generated CJS factories.
        //
        // For Rollup (standard vite): runtimeInitStatus MUST be in its own chunk
        // to break init deadlock: loadShare waits for initPromise, remoteEntry
        // resolves initPromise via initResolve. If both are in the same chunk,
        // loadShare blocks remoteEntry from ever executing.
        const runtimeInitId = virtualRuntimeInitStatus.getImportId();
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
        let warnedAboutCodeSplittingGroups = false;
        const ensureCodeSplitting = (output: MutableBundlerOutput) => {
          if (output?.codeSplitting === false) {
            delete output.codeSplitting;
            if (warnedAboutCodeSplitting) return;
            warnedAboutCodeSplitting = true;
            mfWarn(
              'Ignoring `output.codeSplitting = false` because module federation requires chunk splitting.'
            );
            return;
          }

          if (!output?.codeSplitting || typeof output.codeSplitting !== 'object') return;
          if (!('groups' in output.codeSplitting)) return;

          // Don't strip the groups we set ourselves in applyManualChunks — they
          // isolate the loadShare/runtimeInit wrappers and the preload helper.
          const groups = output.codeSplitting.groups;
          if (
            Array.isArray(groups) &&
            groups.some(
              (group) =>
                typeof (group as Partial<CodeSplittingGroup>)?.name === 'function' &&
                patchedManualChunks.has((group as { name: Function }).name)
            )
          ) {
            return;
          }

          delete output.codeSplitting.groups;
          if (Object.keys(output.codeSplitting).length === 0) {
            delete output.codeSplitting;
          }
          if (warnedAboutCodeSplittingGroups) return;
          warnedAboutCodeSplittingGroups = true;
          mfWarn(
            'Ignoring `output.codeSplitting.groups` because it conflicts with module federation. ' +
              'Grouping shared dependency init wrappers with their dependent modules can break runtime init order ' +
              'and cause standalone remotes to fail before mount.'
          );
        };

        let warnedAboutManualChunks = false;
        // `useCodeSplitting` selects the bundler-appropriate isolation mechanism:
        // Rolldown (Vite 8+) supports `codeSplitting` (and needs it to relocate the
        // injected preload helper), while Rollup (Vite 5–7) only understands
        // `manualChunks` and rejects `codeSplitting` as an unknown output option.
        const applyManualChunks = (output: MutableBundlerOutput, useCodeSplitting: boolean) => {
          ensureCodeSplitting(output);
          const isPatchedByPlugin =
            typeof output.manualChunks === 'function' &&
            patchedManualChunks.has(output.manualChunks);
          if (output.manualChunks && !isPatchedByPlugin && !warnedAboutManualChunks) {
            warnedAboutManualChunks = true;
            mfWarn(
              'Ignoring `output.manualChunks` because it conflicts with module federation. ' +
                'Module federation transforms shared dependency imports with async init wrappers, and grouping ' +
                'these transformed modules into a single chunk creates circular async dependencies that cause ' +
                'the application to silently hang.'
            );
          }
          const mfChunkName = function (id: string): string | null {
            // Keep runtimeInitStatus in its own chunk to break init deadlock
            if (id.includes(runtimeInitId)) {
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
            // option, and the hoisted-preload-helper deadlock is Rolldown-specific,
            // so keep the original `manualChunks` isolation of runtimeInit/loadShare.
            const mfManualChunks = function (id: string) {
              return mfChunkName(id) ?? undefined;
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
          const groups: CodeSplittingGroup[] = [
            { name: PRELOAD_HELPER_CHUNK, test: PRELOAD_HELPER_TEST, priority: 100 },
            { name: mfChunkName },
          ];
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
      load(id: string) {
        if (id.includes(LOAD_SHARE_TAG) || id.includes(LOAD_REMOTE_TAG)) {
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
        }
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
        isSsrBuild = _command === 'build' && config.build?.ssr === true;
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
          if (SSR_ONLY_PLUGINS.has(pluginPath)) return;
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
        const envTargetDefineValue =
          !options.target && isAstro ? 'undefined' : JSON.stringify(resolvedTarget);

        // Set ENV_TARGET define for tree-shaking Node.js code from the federation runtime
        if (!config.define) config.define = {};
        if (!('ENV_TARGET' in config.define)) {
          config.define['ENV_TARGET'] = envTargetDefineValue;
        }
        if (
          resolvedTarget === 'node' &&
          !('FEDERATION_OPTIMIZE_NO_SNAPSHOT_PLUGIN' in config.define)
        ) {
          config.define['FEDERATION_OPTIMIZE_NO_SNAPSHOT_PLUGIN'] = 'true';
        }

        if (
          options.target &&
          'ENV_TARGET' in config.define &&
          config.define['ENV_TARGET'] !== JSON.stringify(options.target)
        ) {
          mfWarn(
            `ENV_TARGET define (${config.define['ENV_TARGET']}) differs from target option ("${options.target}"). ENV_TARGET will not be overridden.`
          );
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
        const envTargetDefineValue =
          !options.target && isAstro ? 'undefined' : JSON.stringify(options.target ?? 'node');
        // Copy define per environment — Vite may reuse the same object across envs.
        config.define = { ...(config.define ?? {}) };
        if (!('ENV_TARGET' in config.define)) {
          config.define['ENV_TARGET'] = envTargetDefineValue;
        }
        if (!('FEDERATION_OPTIMIZE_NO_SNAPSHOT_PLUGIN' in config.define)) {
          config.define['FEDERATION_OPTIMIZE_NO_SNAPSHOT_PLUGIN'] = 'true';
        }

        if (options.target && config.define['ENV_TARGET'] !== JSON.stringify(options.target)) {
          mfWarn(
            `ENV_TARGET define (${config.define['ENV_TARGET']}) differs from target option ("${options.target}"). ENV_TARGET will not be overridden.`
          );
        }
      },
    },
    ...pluginManifest(options),
    ...pluginSSRRemoteEntry(options),
    ...pluginVarRemoteEntry(),
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
  type PluginManifestOptions,
  type TreeShakingConfig,
};

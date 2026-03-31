import defu from 'defu';
import { readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'pathe';
import { normalizePath, Plugin, UserConfig } from 'vite';
import addEntry from './plugins/pluginAddEntry';
import { checkAliasConflicts } from './plugins/pluginCheckAliasConflicts';
import { PluginDevProxyModuleTopLevelAwait } from './plugins/pluginDevProxyModuleTopLevelAwait';
import pluginDts from './plugins/pluginDts';
import pluginManifest from './plugins/pluginMFManifest';
import pluginModuleParseEnd from './plugins/pluginModuleParseEnd';
import pluginProxyRemoteEntry from './plugins/pluginProxyRemoteEntry';
import pluginProxyRemotes from './plugins/pluginProxyRemotes';
import { proxySharedModule } from './plugins/pluginProxySharedModule_preBuild';
import { pluginRemoteNamedExports } from './plugins/pluginRemoteNamedExports';
import pluginVarRemoteEntry from './plugins/pluginVarRemoteEntry';
import aliasToArrayPlugin from './utils/aliasToArrayPlugin';
import { resolveProxyAlias } from './utils/bundleHelpers';
import {
  isFederationControlChunk,
  sanitizeFederationControlChunk,
} from './utils/controlChunkSanitizer';
import { createModuleFederationError, mfWarn } from './utils/logger';
import {
  ModuleFederationOptions,
  NormalizedModuleFederationOptions,
  normalizeModuleFederationOptions,
  PluginManifestOptions,
} from './utils/normalizeModuleFederationOptions';
import normalizeOptimizeDepsPlugin from './utils/normalizeOptimizeDeps';
import { getIsRolldown, hasPackageDependency, setPackageDetectionCwd } from './utils/packageUtils';
import VirtualModule, { initVirtualModuleInfrastructure } from './utils/VirtualModule';
import {
  getHostAutoInitImportId,
  getHostAutoInitPath,
  getLocalSharedImportMapPath,
  getRemoteEntryId,
  initVirtualModules,
  LOAD_REMOTE_TAG,
  LOAD_SHARE_TAG,
  writeLocalSharedImportMap,
} from './virtualModules';
import { getVirtualExposesId } from './virtualModules/virtualExposes';
import { addUsedShares } from './virtualModules/virtualRemoteEntry';
import { addUsedRemote } from './virtualModules/virtualRemotes';
import { virtualRuntimeInitStatus } from './virtualModules/virtualRuntimeInitStatus';
import {
  getLoadShareImportId,
  getLoadShareModulePath,
  getPreBuildLibImportId,
  writeLoadShareModule,
  writePreBuildLibPath,
} from './virtualModules/virtualShared_preBuild';

const patchedManualChunks = new WeakSet<Function>();

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

/**
 * Plugin that runs FIRST to create virtual module files in the config hook.
 * This prevents 504 "Outdated Optimize Dep" errors by ensuring files exist
 * before Vite's optimization phase.
 */
function createEarlyVirtualModulesPlugin(options: NormalizedModuleFederationOptions): Plugin {
  const { shared, remotes, virtualModuleDir } = options;

  return {
    name: 'vite:module-federation-early-init',
    enforce: 'pre',
    config(config: UserConfig, { command: _command }) {
      const root = config.root || process.cwd();
      setPackageDetectionCwd(root);
      const isVinext = hasPackageDependency('vinext');

      // Create the virtual module directory structure EARLY
      initVirtualModuleInfrastructure(root, virtualModuleDir);

      // Set root for VirtualModule class
      VirtualModule.setRoot(root);
      VirtualModule.ensureVirtualPackageExists();

      // Create core virtual modules
      initVirtualModules(_command, getRemoteEntryId(options));

      const isRolldown = getIsRolldown(this);

      // Eagerly register configured remotes before localSharedImportMap is
      // first written. In build, remoteEntry can be traced before app modules
      // hit the remote alias resolver, which otherwise leaves usedRemotes empty
      // in the emitted localSharedImportMap chunk.
      if (remotes && Object.keys(remotes).length > 0) {
        for (const key of Object.keys(remotes)) {
          addUsedRemote(key, key);
        }
      }

      // Create shared module virtual files EARLY and register shares eagerly
      // so localSharedImportMap has content on first load in both serve/build.
      if (shared && Object.keys(shared).length > 0) {
        if (_command === 'serve') {
          config.optimizeDeps = config.optimizeDeps || {};
          config.optimizeDeps.include = config.optimizeDeps.include || [];
          // Include the runtimeInit virtual module so Vite pre-bundles it
          // upfront instead of discovering it at runtime via loadShare imports.
          config.optimizeDeps.include.push(virtualRuntimeInitStatus.getImportId());
          if (isRolldown) {
            // In Vite 8 dev, prebundling bare remote specifiers rewrites
            // `import("remote/x")` to `/node_modules/.vite/deps/remote_x.js`.
            // That bypasses the remote namespace fixup path and breaks named
            // exports on dynamic import, which Angular relies on.
            config.optimizeDeps.exclude = config.optimizeDeps.exclude || [];
            config.optimizeDeps.exclude.push(...Object.keys(remotes || {}));
          }
        }
        for (const key of Object.keys(shared)) {
          if (key.endsWith('/')) continue;
          const shareItem = shared[key] as any;
          if (isVinext && key === 'react') {
            addUsedShares(key);
            continue;
          }
          getLoadShareModulePath(key, isRolldown);
          writeLoadShareModule(key, shareItem, _command, isRolldown);
          // Skip prebuild for shared deps with import: false — the host must
          // provide them, so no local fallback source is needed.
          if (shareItem.shareConfig?.import !== false) {
            writePreBuildLibPath(key, shareItem);
          }
          addUsedShares(key);
          if (_command === 'serve' && shareItem.shareConfig?.import !== false) {
            if (!isRolldown) {
              // In non-Rolldown Vite (< 8), loadShare modules are CJS and
              // don't use real TLA, so the dep optimizer handles them fine.
              config.optimizeDeps.include!.push(getLoadShareImportId(key, isRolldown, _command));
            }
            // When isRolldown (Vite 8+), loadShare modules are ESM with
            // top-level await. Including them in optimizeDeps causes the dep
            // optimizer to convert ESM→CJS, stripping `await` and turning
            // shared modules into unresolved Promises (breaks Pinia plugins, etc).
            config.optimizeDeps.include!.push(getPreBuildLibImportId(key));
          }
        }
        writeLocalSharedImportMap();
      }
    },
  };
}

function federation(mfUserOptions: ModuleFederationOptions): Plugin[] {
  const options = normalizeModuleFederationOptions(mfUserOptions);
  const isVinext = hasPackageDependency('vinext');
  const { name, remotes, shared, filename, hostInitInjectLocation } = options;
  if (!name) throw createModuleFederationError('name is required');

  const remoteEntryId = getRemoteEntryId(options);
  const virtualExposesId = getVirtualExposesId(options);

  let command: string;
  let depsDir = '/node_modules/.vite/deps/';

  return [
    // This plugin runs FIRST to create virtual module files before optimization
    createEarlyVirtualModulesPlugin(options),
    ...(isVinext
      ? [
          {
            name: 'module-federation-vinext-react-server-build-alias',
            apply: 'build' as const,
            enforce: 'pre' as const,
            resolveId(id) {
              const reactServerEntryMap: Record<string, string> = {
                'react/jsx-runtime': 'react/cjs/react-jsx-runtime.production.js',
                'react/jsx-dev-runtime': 'react/cjs/react-jsx-dev-runtime.production.js',
              };
              if (!(id in reactServerEntryMap)) return;
              const environmentName = (this as any)?.environment?.name;
              if (!environmentName || environmentName === 'client') return;

              const target = reactServerEntryMap[id];
              const projectRequire = createRequire(new URL(`file://${process.cwd()}/package.json`));
              const reactPackageJson = projectRequire.resolve('react/package.json');
              return path.join(path.dirname(reactPackageJson), target.replace(/^react\//, ''));
            },
          },
        ]
      : []),
    {
      name: 'vite:module-federation-config',
      enforce: 'pre',
      config(_config, env) {
        command = env.command;
      },
      configResolved(config) {
        // Set root path
        VirtualModule.setRoot(config.root);
        const cacheDir = config.cacheDir;
        if (cacheDir) {
          const resolved = path.isAbsolute(cacheDir)
            ? cacheDir
            : path.resolve(config.root, cacheDir);
          depsDir = normalizePath(path.join(resolved, 'deps')) + '/';
        } else {
          depsDir = normalizePath(path.join(config.root, 'node_modules', '.vite', 'deps')) + '/';
        }
        // Ensure virtual package directory exists
        VirtualModule.ensureVirtualPackageExists();
        initVirtualModules(command, remoteEntryId);
      },
    },
    aliasToArrayPlugin,
    checkAliasConflicts({ shared }),
    normalizeOptimizeDepsPlugin,
    ...pluginDts(options),
    ...addEntry({
      entryName: 'remoteEntry',
      entryPath: remoteEntryId,
      fileName: filename,
    }),
    ...addEntry({
      entryName: 'hostInit',
      entryPath: () => getHostAutoInitPath(),
      inject: hostInitInjectLocation,
    }),
    ...addEntry({
      entryName: 'virtualExposes',
      entryPath: virtualExposesId,
    }),
    pluginProxyRemoteEntry({ options, remoteEntryId, virtualExposesId }),
    pluginProxyRemotes(options),
    pluginRemoteNamedExports(options),
    ...pluginModuleParseEnd(
      (id: string) => {
        return (
          id.includes(getHostAutoInitImportId()) ||
          id.includes(remoteEntryId) ||
          id.includes(virtualExposesId) ||
          id.includes(getLocalSharedImportMapPath())
        );
      },
      {
        moduleParseTimeout: options.moduleParseTimeout,
        moduleParseIdleTimeout: options.moduleParseIdleTimeout,
        virtualExposesId,
      }
    ),
    ...proxySharedModule({
      shared,
    }),
    {
      name: 'module-federation-esm-shims',
      enforce: 'pre',
      apply: 'build',
      config(config) {
        // Force loadShare modules and runtimeInitStatus into separate chunks.
        //
        // For Vite 8+: loadShare chunks need separate TLA barriers
        // so the generateBundle hook can patch CJS factories with top-level await.
        //
        // For Rollup (standard vite): runtimeInitStatus MUST be in its own chunk
        // to break TLA deadlock: loadShare has TLA waiting for initPromise,
        // remoteEntry resolves initPromise via initResolve — if both are in the
        // same chunk, the TLA blocks remoteEntry from ever executing.
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
            resolveDependencies(filename, deps, context) {
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

              return shouldSkipFederationPreload ? [] : resolvedDeps;
            },
          };
        }

        let warnedAboutCodeSplitting = false;
        const ensureCodeSplitting = (output: any) => {
          if (output?.codeSplitting !== false) return;
          delete output.codeSplitting;
          if (warnedAboutCodeSplitting) return;
          warnedAboutCodeSplitting = true;
          mfWarn(
            'Ignoring `build.rolldownOptions.output.codeSplitting = false` because module federation requires chunk splitting.'
          );
        };

        let warnedAboutManualChunks = false;
        const applyManualChunks = (output: any) => {
          ensureCodeSplitting(output);
          const isPatchedByPlugin = !!(
            output.manualChunks && patchedManualChunks.has(output.manualChunks as Function)
          );
          if (output.manualChunks && !isPatchedByPlugin && !warnedAboutManualChunks) {
            warnedAboutManualChunks = true;
            mfWarn(
              'Ignoring `build.rollupOptions.output.manualChunks` because it conflicts with module federation. ' +
                'Module federation transforms shared dependency imports with top-level await, and grouping ' +
                'these transformed modules into a single chunk creates circular async dependencies that cause ' +
                'the application to silently hang.'
            );
          }
          const mfManualChunks = function (id: string) {
            // Keep runtimeInitStatus in its own chunk to break TLA deadlock
            if (id.includes(runtimeInitId)) {
              return 'runtimeInit';
            }
            if (id.includes(LOAD_SHARE_TAG)) {
              // Use the virtual module path as the chunk name
              const match = id.match(/([^/\\]+__loadShare__[^/\\]+)/);
              return match ? match[1] : 'loadShare';
            }
          };
          patchedManualChunks.add(mfManualChunks);
          output.manualChunks = mfManualChunks;
        };

        config.build.rollupOptions = config.build.rollupOptions || {};
        if (!Array.isArray(config.build.rollupOptions.output)) {
          applyManualChunks((config.build.rollupOptions.output ||= {}) as any);
        }

        // Vite 8+ reads build.rolldownOptions instead of rollupOptions.
        // Apply the same split there so runtimeInit and loadShare stay isolated
        // under both bundlers.
        const buildWithRolldown = config.build as typeof config.build & {
          rolldownOptions?: { output?: any };
        };
        buildWithRolldown.rolldownOptions = buildWithRolldown.rolldownOptions || {};
        if (!Array.isArray(buildWithRolldown.rolldownOptions.output)) {
          applyManualChunks((buildWithRolldown.rolldownOptions.output ||= {}) as any);
        }
      },
      load(id) {
        if (id.startsWith('\0')) return;
        if (id.includes(LOAD_SHARE_TAG) || id.includes(LOAD_REMOTE_TAG)) {
          let code = readFileSync(id, 'utf-8');

          // Remove static imports/re-exports of prebuild modules to prevent
          // Rollup from merging them into the loadShare chunk.  Without this,
          // Rollup deduplicates and merges React code into the loadShare chunk,
          // so get() in localSharedImportMap ends up dynamically importing the
          // SAME chunk whose TLA is already executing → self-referential deadlock.
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
          code = code.replace(
            'export default exportModule',
            'export const __moduleExports = exportModule;\n' +
              'export default exportModule.__esModule ? exportModule.default : exportModule'
          );
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
      generateBundle(_, bundle) {
        for (const [fileName, chunk] of Object.entries(bundle)) {
          if (chunk.type !== 'chunk') continue;
          if (!isFederationControlChunk(fileName, filename)) continue;

          chunk.code = sanitizeFederationControlChunk(chunk.code, fileName, filename);
        }

        // Pass 1: Add top-level await for CJS init functions
        for (const [fileName, chunk] of Object.entries(bundle)) {
          if (chunk.type !== 'chunk') continue;
          if (fileName.includes(LOAD_SHARE_TAG)) continue;

          let code = chunk.code;
          let m;
          const importedFromLoadShare = new Set<string>();
          const importRegex = /import\s*\{([^}]+)\}\s*from\s*["'][^"']*__loadShare__[^"']*["']/g;
          while ((m = importRegex.exec(code)) !== null) {
            for (const spec of m[1].split(',')) {
              const parts = spec.trim().split(/\s+as\s+/);
              const local = (parts[1] || parts[0]).trim();
              if (local) importedFromLoadShare.add(local);
            }
          }

          const allInits: string[] = [];
          for (const v of importedFromLoadShare) {
            if (new RegExp('\\(' + v + '\\(\\)\\s*,\\s*\\w+\\(\\w+\\)\\)').test(code)) {
              allInits.push(v);
            }
          }
          if (allInits.length === 0) continue;

          const awaits = allInits.map((v) => `await ${v}();`).join('');
          const lastFromRegex = /\bfrom\s*["'][^"']*["']\s*;?/g;
          let lastFromEnd = -1;
          while ((m = lastFromRegex.exec(code)) !== null) {
            lastFromEnd = m.index + m[0].length;
          }
          if (lastFromEnd !== -1) {
            chunk.code = code.slice(0, lastFromEnd) + awaits + code.slice(lastFromEnd);
            continue;
          }
          const exportIdx = code.search(/\bexport\s*[{d]/);
          if (exportIdx !== -1) {
            chunk.code = code.slice(0, exportIdx) + awaits + code.slice(exportIdx);
            continue;
          }
        }

        // Pass 2 (standard vite/Rollup): Break transitive TLA deadlock.
        //
        // Rollup's CJS plugin creates commonjs-proxy wrapper chunks for
        // loadShare modules. These proxies share CJS helpers
        // (getDefaultExportFromCjs, getAugmentedNamespace) with prebuild
        // chunks (react, react-dom). This creates a transitive dependency:
        //   prebuild chunk → commonjs-proxy → loadShare chunk (has TLA)
        // When get() dynamically imports the prebuild chunk during
        // loadShare's TLA execution, it blocks on itself → deadlock.
        //
        // Fix: extract helper functions from commonjs-proxy chunks and
        // inline them in consuming chunks, then remove the proxy imports.
        const proxyChunks = new Map<string, { code: string; fileName: string }>();
        for (const [fileName, chunk] of Object.entries(bundle)) {
          if (chunk.type !== 'chunk') continue;
          if (fileName.includes(LOAD_SHARE_TAG) && fileName.includes('commonjs-proxy')) {
            proxyChunks.set(fileName, { code: chunk.code, fileName });
          }
        }
        if (proxyChunks.size > 0) {
          // Extract helper functions from each proxy chunk.
          // Proxy chunks export: standalone helpers + wrapped loadShare namespace.
          // We only inline the standalone helpers; namespace deps are redirected.
          for (const [fileName, chunk] of Object.entries(bundle)) {
            if (chunk.type !== 'chunk') continue;
            if (fileName.includes(LOAD_SHARE_TAG)) continue;

            let code = chunk.code;
            let modified = false;
            const claimedLocals = new Set<string>();

            for (const [proxyFileName, proxyInfo] of proxyChunks) {
              // Match import from this specific proxy chunk
              // Strip directory prefix (bundle keys use "assets/" but imports use "./")
              const proxyBaseName = proxyFileName
                .replace(/^.*\//, '')
                .replace(/\.js$/, '')
                .replace(/-[A-Za-z0-9_-]+$/, '');
              const importRe = new RegExp(
                `import\\s*\\{([^}]+)\\}\\s*from\\s*["']([^"']*${proxyBaseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"']*)["']\\s*;?`
              );
              const importMatch = importRe.exec(code);
              if (!importMatch) continue;

              const fullImport = importMatch[0];
              const bindings = importMatch[1].split(',').map((s) => {
                const parts = s.trim().split(/\s+as\s+/);
                return {
                  imported: parts[0].trim(),
                  local: (parts[1] || parts[0]).trim(),
                };
              });

              // Parse the proxy chunk's export map: export{s as a, u as g, f as r}
              const proxyCode = proxyInfo.code;
              const exportMapMatch = proxyCode.match(/export\s*\{([^}]+)\}/);
              if (!exportMapMatch) continue;
              const exportMap: Record<string, string> = {};
              for (const entry of exportMapMatch[1].split(',')) {
                const parts = entry.trim().split(/\s+as\s+/);
                if (parts.length === 2) {
                  exportMap[parts[1].trim()] = parts[0].trim();
                }
              }

              // Classify each imported binding as a standalone function or a
              // loadShare-dependent value.
              const inlineable: Array<{ local: string; funcBody: string }> = [];
              const nonInlineable: Array<{ imported: string; local: string }> = [];
              const pendingLocals = new Set(bindings.map((binding) => binding.local));

              for (const b of bindings) {
                pendingLocals.delete(b.local);
                const proxyLocal = exportMap[b.imported];
                if (!proxyLocal) {
                  claimedLocals.add(b.local);
                  nonInlineable.push(b);
                  continue;
                }
                // Check if this is a function definition (standalone helper)
                const funcRe = new RegExp(`function\\s+${proxyLocal}\\s*\\([^)]*\\)\\s*\\{`);
                if (funcRe.test(proxyCode)) {
                  // Extract function body with balanced braces
                  const funcStart = proxyCode.search(funcRe);
                  let depth = 0;
                  let funcEnd = funcStart;
                  for (let i = proxyCode.indexOf('{', funcStart); i < proxyCode.length; i++) {
                    if (proxyCode[i] === '{') depth++;
                    else if (proxyCode[i] === '}') {
                      depth--;
                      if (depth === 0) {
                        funcEnd = i + 1;
                        break;
                      }
                    }
                  }
                  const funcBody = proxyCode.slice(funcStart, funcEnd);
                  // Rename function to match local binding name
                  const renamedFunc = funcBody.replace(
                    new RegExp(`function\\s+${proxyLocal}\\s*\\(`),
                    `function ${b.local}(`
                  );
                  inlineable.push({ local: b.local, funcBody: renamedFunc });
                  claimedLocals.add(b.local);
                } else {
                  const unavailableLocals = new Set(claimedLocals);
                  pendingLocals.forEach((local) => unavailableLocals.add(local));
                  const resolvedBinding = resolveProxyAlias(
                    b,
                    proxyLocal,
                    code,
                    fullImport,
                    unavailableLocals
                  );
                  claimedLocals.add(resolvedBinding.local);
                  nonInlineable.push(resolvedBinding);
                }
              }

              // Also rewrite the import when only an alias was corrected.
              const hasRenamedAlias = nonInlineable.some(
                (b) => bindings.find((ob) => ob.imported === b.imported)?.local !== b.local
              );
              if (inlineable.length === 0 && !hasRenamedAlias) continue;

              // Build the replacement
              let replacement = '';
              if (nonInlineable.length > 0) {
                // Keep import for non-inlineable bindings only
                const kept = nonInlineable
                  .map((b) => (b.imported === b.local ? b.imported : `${b.imported} as ${b.local}`))
                  .join(',');
                replacement = `import{${kept}}from"${importMatch[2]}";`;
              }
              // Add inlined function definitions
              replacement += inlineable.map((f) => f.funcBody).join('');

              // Use a function to avoid '$' special handling in replacement strings ('$$' → '$').
              code = code.replace(fullImport, () => replacement);
              modified = true;
            }

            if (modified) {
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
      renderChunk(code, chunk) {
        if (!isFederationControlChunk(chunk.fileName, filename)) return;

        const nextCode = sanitizeFederationControlChunk(code, chunk.fileName, filename);

        return nextCode === code ? null : { code: nextCode, map: null };
      },
      writeBundle(outputOptions, bundle) {
        if (!outputOptions.dir) return;

        for (const chunk of Object.values(bundle)) {
          if (chunk.type !== 'chunk') continue;
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
      name: 'module-federation-dev-await-shared-init',
      apply: 'serve',
      enforce: 'post',
      transform(code, id) {
        if (!id.includes(depsDir)) return;
        // Find all init__loadShare__ calls that are used synchronously
        // inside CJS wrappers (comma expressions) and add top-level await
        const initPattern = /\b(init_\w+__loadShare__\w+)\b/g;
        const initFns = new Set<string>();
        let match;
        while ((match = initPattern.exec(code)) !== null) {
          initFns.add(match[1]);
        }
        if (initFns.size === 0) return;

        // Check if any of these inits are called without await (inside CJS IIFEs)
        const hasUnawaited = [...initFns].some((fn) => {
          // Pattern: fn() used as expression statement (not awaited)
          return code.includes(`${fn}(),`) || code.includes(`${fn}()`);
        });
        if (!hasUnawaited) return;

        // Don't patch the entry files that already have top-level await
        if (/await\s+init_\w+__loadShare__/.test(code)) return;
        // Don't patch the loadShare chunk files themselves
        if (code.includes('__esmMin')) return;

        // Add top-level awaits after imports
        const awaits = [...initFns].map((fn) => `await ${fn}();`).join('\n');
        // Insert after the last top-level import statement.
        // Use a regex anchored to the start of a line to avoid matching
        // "import" inside strings (e.g. error messages like
        // "You should instead import it from \"react-dom/client\"").
        const topLevelImportRe = /^import\s/gm;
        let lastImportIdx = -1;
        let importMatch;
        while ((importMatch = topLevelImportRe.exec(code)) !== null) {
          lastImportIdx = importMatch.index;
        }
        if (lastImportIdx === -1) return;
        const lineEnd = code.indexOf('\n', lastImportIdx);
        return code.slice(0, lineEnd + 1) + awaits + '\n' + code.slice(lineEnd + 1);
      },
    },
    PluginDevProxyModuleTopLevelAwait(),
    {
      name: 'module-federation-vite',
      enforce: 'post',
      // @ts-expect-error
      // used to expose plugin options: https://github.com/rolldown/rolldown/discussions/2577#discussioncomment-11137593
      _options: options,
      config(config, { command: _command }: { command: string }) {
        const isRolldown = getIsRolldown(this);

        // For Vite 8+, resolve to ESM entry
        // because Vite 8's internal bundler cannot parse dynamic import() in .cjs files
        let implementation = options.implementation;
        if (isRolldown) {
          implementation = implementation.replace(/\.cjs(\.js)?$/, '.js');
        }
        // TODO: singleton
        (config.resolve as any).alias.push({
          find: '@module-federation/runtime',
          replacement: implementation,
        });
        config.build = defu(config.build || {}, {
          commonjsOptions: {
            strictRequires: 'auto',
          },
        });
        const virtualDir = options.virtualModuleDir || '__mf__virtual';
        config.optimizeDeps ||= {};
        config.optimizeDeps.include ||= [];
        config.optimizeDeps.include.push('@module-federation/runtime');
        config.optimizeDeps.include.push(virtualDir);

        // Prevent Vite from externalizing virtual modules during SSR.
        // Files in node_modules/__mf__virtual/ contain `import("virtual:...")`
        // which Node's native ESM loader cannot resolve. By marking them as
        // non-external, Vite processes them through its plugin pipeline
        // (resolveId/load hooks) so `virtual:` imports are handled correctly.
        config.ssr ||= {};
        config.ssr.noExternal ||= [];
        if (Array.isArray(config.ssr.noExternal)) {
          config.ssr.noExternal.push(virtualDir);
        }

        // Add all runtime plugins to optimizeDeps to prevent 504 re-optimization
        options.runtimePlugins.forEach((p) => {
          const pluginPath = typeof p === 'string' ? p : p[0];
          // Only add bare imports to optimizeDeps
          if (
            pluginPath &&
            !pluginPath.startsWith('.') &&
            !pluginPath.startsWith('/') &&
            !pluginPath.startsWith('\0') &&
            !pluginPath.startsWith('virtual:')
          ) {
            config.optimizeDeps!.include!.push(pluginPath);
          }
        });

        if (isRolldown) {
          // Vite 8+: virtual modules use ESM, set target for top-level await
          config.build = defu(config.build || {}, { target: 'esnext' });
        } else {
          // Vite 5-7: virtual modules use CJS for dev, need interop
          config.optimizeDeps.needsInterop ||= [];
          config.optimizeDeps.needsInterop.push(virtualDir);
          config.optimizeDeps.needsInterop.push(getLocalSharedImportMapPath());
        }

        const isAstro = hasPackageDependency('astro');
        // Resolve target: explicit option > SSR detection > 'web'
        const resolvedTarget = options.target ?? (config.build?.ssr ? 'node' : 'web');
        const envTargetDefineValue =
          !options.target && isAstro ? 'undefined' : JSON.stringify(resolvedTarget);

        // Set ENV_TARGET define for tree-shaking Node.js code from the federation runtime
        if (!config.define) config.define = {};
        if (!('ENV_TARGET' in config.define)) {
          config.define['ENV_TARGET'] = envTargetDefineValue;
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
    },
    ...pluginManifest(),
    ...pluginVarRemoteEntry(),
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
                const isConsumerProject = Object.keys(options.exposes).length === 0;
                const getDefaultDisableAssetsAnalyze = (cfgCommand: string | undefined) =>
                  cfgCommand === 'serve' &&
                  isConsumerProject &&
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
              generateBundle(_: unknown, bundle: Record<string, any>) {
                if (disablePreload) return;

                for (const chunk of Object.values(bundle)) {
                  if (chunk.type !== 'chunk') continue;
                  if (!chunk.code.includes('modulepreload')) continue;
                  const chunkDir = path.dirname(chunk.fileName);
                  const prefixToRoot = chunkDir === '.' ? '' : `${path.relative(chunkDir, '.')}/`;
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
                  const replaced = chunk.code.replace(
                    /=\(?(\w+)(?:,\w+)?\)?\s*=>\s*["'`][^"'`]*["'`]\s*\+\s*\1/,
                    replacement
                  );
                  if (replaced !== chunk.code) {
                    chunk.code = replaced;
                    continue;
                  }
                  // Function expression: function(e){return"/"+e} (1 or 2 params)
                  chunk.code = chunk.code.replace(
                    /=function\((\w+)(?:,\w+)?\)\{return\s*["'`][^"'`]*["'`]\s*\+\s*\1\s*\}/,
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

export { federation, type ModuleFederationOptions, type PluginManifestOptions };

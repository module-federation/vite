import defu from 'defu';
import { readFileSync } from 'fs';
import { Plugin, UserConfig } from 'vite';
import addEntry from './plugins/pluginAddEntry';
import { checkAliasConflicts } from './plugins/pluginCheckAliasConflicts';
import { PluginDevProxyModuleTopLevelAwait } from './plugins/pluginDevProxyModuleTopLevelAwait';
import pluginDts from './plugins/pluginDts';
import pluginManifest from './plugins/pluginMFManifest';
import pluginModuleParseEnd from './plugins/pluginModuleParseEnd';
import pluginProxyRemoteEntry from './plugins/pluginProxyRemoteEntry';
import pluginProxyRemotes from './plugins/pluginProxyRemotes';
import { proxySharedModule } from './plugins/pluginProxySharedModule_preBuild';
import pluginVarRemoteEntry from './plugins/pluginVarRemoteEntry';
import aliasToArrayPlugin from './utils/aliasToArrayPlugin';
import {
  ModuleFederationOptions,
  normalizeModuleFederationOptions,
  NormalizedModuleFederationOptions,
} from './utils/normalizeModuleFederationOptions';
import normalizeOptimizeDepsPlugin from './utils/normalizeOptimizeDeps';
import VirtualModule, { initVirtualModuleInfrastructure } from './utils/VirtualModule';
import {
  getHostAutoInitImportId,
  getHostAutoInitPath,
  getLocalSharedImportMapPath,
  initVirtualModules,
  LOAD_REMOTE_TAG,
  LOAD_SHARE_TAG,
  REMOTE_ENTRY_ID,
  writeLocalSharedImportMap,
} from './virtualModules';
import { VIRTUAL_EXPOSES } from './virtualModules/virtualExposes';
import {
  writeLoadShareModule,
  writePreBuildLibPath,
  getLoadShareModulePath,
} from './virtualModules/virtualShared_preBuild';
import { addUsedShares } from './virtualModules/virtualRemoteEntry';
import { virtualRuntimeInitStatus } from './virtualModules/virtualRuntimeInitStatus';

/**
 * Plugin that runs FIRST to create virtual module files in the config hook.
 * This prevents 504 "Outdated Optimize Dep" errors by ensuring files exist
 * before Vite's optimization phase.
 */
function createEarlyVirtualModulesPlugin(options: NormalizedModuleFederationOptions): Plugin {
  const { name, shared, virtualModuleDir } = options;

  return {
    name: 'vite:module-federation-early-init',
    enforce: 'pre',
    config(config: UserConfig, { command: _command }) {
      if (_command !== 'serve') return;

      const root = config.root || process.cwd();

      // Create the virtual module directory structure EARLY
      initVirtualModuleInfrastructure(root, virtualModuleDir);

      // Set root for VirtualModule class
      VirtualModule.setRoot(root);
      VirtualModule.ensureVirtualPackageExists();

      // Create core virtual modules
      initVirtualModules(_command);

      // Collect import IDs for optimizeDeps.include
      const virtualModuleImportIds: string[] = [];

      // Create shared module virtual files BEFORE optimization
      if (shared && Object.keys(shared).length > 0) {
        for (const key of Object.keys(shared)) {
          const shareItem = shared[key] as any;
          writeLoadShareModule(key, shareItem, _command);
          writePreBuildLibPath(key);
          addUsedShares(key);
          // Only add loadShare paths (NOT prebuild - they're empty placeholders)
          virtualModuleImportIds.push(getLoadShareModulePath(key));
        }
        writeLocalSharedImportMap();
      }

      virtualModuleImportIds.push(virtualRuntimeInitStatus.getImportId());

      // Add virtual modules to optimizeDeps.include
      if (!config.optimizeDeps) config.optimizeDeps = {};
      if (!config.optimizeDeps.include) config.optimizeDeps.include = [];
      if (!config.optimizeDeps.needsInterop) config.optimizeDeps.needsInterop = [];

      for (const importId of virtualModuleImportIds) {
        if (!config.optimizeDeps.include.includes(importId)) {
          config.optimizeDeps.include.push(importId);
        }
        if (!config.optimizeDeps.needsInterop.includes(importId)) {
          config.optimizeDeps.needsInterop.push(importId);
        }
      }
    },
  };
}

function federation(mfUserOptions: ModuleFederationOptions): Plugin[] {
  const options = normalizeModuleFederationOptions(mfUserOptions);
  const { name, remotes, shared, filename, hostInitInjectLocation } = options;
  if (!name) throw new Error('name is required');

  let command: string;

  return [
    // This plugin runs FIRST to create virtual module files before optimization
    createEarlyVirtualModulesPlugin(options),
    {
      name: 'vite:module-federation-config',
      enforce: 'pre',
      config(_config, env) {
        command = env.command;
      },
      configResolved(config) {
        // Set root path
        VirtualModule.setRoot(config.root);
        // Ensure virtual package directory exists
        VirtualModule.ensureVirtualPackageExists();
        initVirtualModules(command);
      },
    },
    aliasToArrayPlugin,
    checkAliasConflicts({ shared }),
    normalizeOptimizeDepsPlugin,
    ...pluginDts(options),
    ...addEntry({
      entryName: 'remoteEntry',
      entryPath: REMOTE_ENTRY_ID,
      fileName: filename,
    }),
    ...addEntry({
      entryName: 'hostInit',
      entryPath: getHostAutoInitPath(),
      inject: hostInitInjectLocation,
    }),
    ...addEntry({
      entryName: 'virtualExposes',
      entryPath: VIRTUAL_EXPOSES,
    }),
    pluginProxyRemoteEntry(),
    pluginProxyRemotes(options),
    ...pluginModuleParseEnd(
      (id: string) => {
        return (
          id.includes(getHostAutoInitImportId()) ||
          id.includes(REMOTE_ENTRY_ID) ||
          id.includes(VIRTUAL_EXPOSES) ||
          id.includes(getLocalSharedImportMapPath())
        );
      },
      {
        moduleParseTimeout: options.moduleParseTimeout,
      }
    ),
    ...proxySharedModule({
      shared,
    }),
    {
      name: 'module-federation-esm-shims',
      enforce: 'pre',
      apply: 'build',
      load(id) {
        if (id.startsWith('\0')) return;
        if (id.includes(LOAD_SHARE_TAG) || id.includes(LOAD_REMOTE_TAG)) {
          let code = readFileSync(id, 'utf-8');
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
          return { code, syntheticNamedExports: '__moduleExports' };
        }
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
        // TODO: singleton
        (config.resolve as any).alias.push({
          find: '@module-federation/runtime',
          replacement: options.implementation,
        });
        config.build = defu(config.build || {}, {
          commonjsOptions: {
            strictRequires: 'auto',
          },
        });
        const virtualDir = options.virtualModuleDir || '__mf__virtual';
        config.optimizeDeps?.include?.push('@module-federation/runtime');
        config.optimizeDeps?.include?.push(virtualDir);
        config.optimizeDeps?.needsInterop?.push(virtualDir);
        config.optimizeDeps?.needsInterop?.push(getLocalSharedImportMapPath());

        // Resolve target: explicit option > SSR detection > 'web'
        const resolvedTarget = options.target ?? (config.build?.ssr ? 'node' : 'web');

        // Set ENV_TARGET define for tree-shaking Node.js code from the federation runtime
        if (!config.define) config.define = {};
        if (!('ENV_TARGET' in config.define)) {
          config.define['ENV_TARGET'] = JSON.stringify(resolvedTarget);
        }

        if (
          options.target &&
          'ENV_TARGET' in config.define &&
          config.define['ENV_TARGET'] !== JSON.stringify(options.target)
        ) {
          console.warn(
            `[module-federation] ENV_TARGET define (${config.define['ENV_TARGET']}) differs from target option ("${options.target}"). ENV_TARGET will not be overridden.`
          );
        }
      },
    },
    ...pluginManifest(),
    ...pluginVarRemoteEntry(),
  ];
}

export { federation };

import { normalizeOptions, type moduleFederationPlugin } from '@module-federation/sdk';
import {
  consumeTypesAPI,
  generateTypesAPI,
  isTSProject,
  normalizeConsumeTypesOptions,
  normalizeDtsOptions,
  normalizeGenerateTypesOptions,
} from '@module-federation/dts-plugin';
import { rpc, type DTSManagerOptions } from '@module-federation/dts-plugin/core';
import * as path from 'pathe';
import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite';
import type { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';

type DevOptions = {
  disableLiveReload?: boolean;
  disableHotTypesReload?: boolean;
  disableDynamicRemoteTypeHints?: boolean;
};

const DEFAULT_DEV_OPTIONS: Required<DevOptions> = {
  disableLiveReload: true,
  disableHotTypesReload: false,
  disableDynamicRemoteTypeHints: false,
};

const DYNAMIC_HINTS_PLUGIN = '@module-federation/dts-plugin/dynamic-remote-type-hints-plugin';

const getIPv4 = () => process.env['FEDERATION_IPV4'] || '127.0.0.1';

type DevWorkerOptions = DTSManagerOptions & {
  name: string;
  disableLiveReload?: boolean;
  disableHotTypesReload?: boolean;
};

const forkDevWorkerPath = (() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require.resolve('@module-federation/dts-plugin/dist/fork-dev-worker.js');
})();

class DevWorker {
  private readonly worker = rpc.createRpcWorker(forkDevWorkerPath, {}, undefined, false);

  constructor(options: DevWorkerOptions) {
    this.worker.connect(options);
  }

  update(): void {
    this.worker.process?.send?.({
      type: rpc.RpcGMCallTypes.CALL,
      id: this.worker.id,
      args: [undefined, 'update'],
    });
  }

  exit(): void {
    this.worker.terminate();
  }
}

const normalizeDevOptions = (dev: NormalizedModuleFederationOptions['dev']): DevOptions | false => {
  if (dev === false) {
    return false;
  }
  if (dev === true || typeof dev === 'undefined') {
    return { ...DEFAULT_DEV_OPTIONS };
  }
  return { ...DEFAULT_DEV_OPTIONS, ...dev };
};

const buildDtsModuleFederationConfig = (
  options: NormalizedModuleFederationOptions
): moduleFederationPlugin.ModuleFederationPluginOptions => {
  const exposes: Record<string, string> = {};
  Object.entries(options.exposes).forEach(([key, value]) => {
    if (typeof value === 'string') {
      exposes[key] = value;
      return;
    }
    const importValue = Array.isArray(value.import) ? value.import[0] : value.import;
    if (importValue) {
      exposes[key] = importValue;
    }
  });

  const remotes: Record<string, string> = {};
  Object.entries(options.remotes).forEach(([key, remote]) => {
    if (typeof remote === 'string') {
      remotes[key] = remote;
      return;
    }
    if (!remote.entry) {
      return;
    }
    const entryLooksLikeUrl =
      remote.entryGlobalName?.startsWith('http') || remote.entryGlobalName?.includes('.json');
    const entryGlobalName = entryLooksLikeUrl
      ? remote.name || key
      : remote.entryGlobalName || remote.name || key;
    remotes[key] = `${entryGlobalName}@${remote.entry}`;
  });

  return {
    ...(options as unknown as moduleFederationPlugin.ModuleFederationPluginOptions),
    exposes,
    remotes,
  };
};

const resolveOutputDir = (config: ResolvedConfig): string => {
  const { outDir } = config.build;
  if (path.isAbsolute(outDir)) {
    return path.relative(config.root, outDir);
  }
  return outDir;
};

const ensureRuntimePlugin = (
  options: NormalizedModuleFederationOptions,
  pluginId: string
): void => {
  const hasPlugin = options.runtimePlugins.some((plugin) => {
    if (typeof plugin === 'string') {
      return plugin === pluginId;
    }
    return plugin[0] === pluginId;
  });

  if (!hasPlugin) {
    options.runtimePlugins.push(pluginId);
  }
};

const normalizeDevDtsOptions = (
  dts: NormalizedModuleFederationOptions['dts'],
  context: string
): moduleFederationPlugin.PluginDtsOptions | false => {
  const defaultGenerateTypes: moduleFederationPlugin.DtsRemoteOptions = {
    compileInChildProcess: true,
  };
  const defaultConsumeTypes: moduleFederationPlugin.DtsHostOptions = {
    consumeAPITypes: true,
  };

  return normalizeOptions<moduleFederationPlugin.PluginDtsOptions>(
    isTSProject(dts as moduleFederationPlugin.ModuleFederationPluginOptions['dts'], context),
    {
      generateTypes: defaultGenerateTypes,
      consumeTypes: defaultConsumeTypes,
      extraOptions: {},
      displayErrorInTerminal:
        typeof dts === 'object' && dts
          ? (dts as moduleFederationPlugin.PluginDtsOptions).displayErrorInTerminal
          : undefined,
    },
    'mfOptions.dts'
  )(dts as moduleFederationPlugin.PluginDtsOptions | boolean | undefined);
};

const logDtsError = (
  error: unknown,
  dtsOptions?: moduleFederationPlugin.PluginDtsOptions | false
) => {
  if (dtsOptions && dtsOptions.displayErrorInTerminal !== false) {
    console.error(error);
  }
};

export default function pluginDts(options: NormalizedModuleFederationOptions): Plugin[] {
  if (options.dts === false) {
    return [];
  }

  const dtsModuleFederationConfig = buildDtsModuleFederationConfig(options);
  let resolvedConfig: ResolvedConfig | undefined;
  let devWorker: DevWorker | undefined;
  let normalizedDevOptions: DevOptions | false | undefined;
  let hasGeneratedBundle = false;

  const devPlugin: Plugin = {
    name: 'module-federation-dts-dev',
    apply: 'serve',
    config(config) {
      normalizedDevOptions = normalizeDevOptions(options.dev);
      if (!normalizedDevOptions) {
        return;
      }

      if (normalizedDevOptions.disableDynamicRemoteTypeHints) {
        return;
      }

      ensureRuntimePlugin(options, DYNAMIC_HINTS_PLUGIN);
      const define = config.define ? { ...config.define } : {};
      if (!('FEDERATION_IPV4' in define)) {
        define.FEDERATION_IPV4 = JSON.stringify(getIPv4());
      }
      config.define = define;
    },
    configResolved(config) {
      resolvedConfig = config;
    },
    configureServer(server: ViteDevServer) {
      if (!normalizedDevOptions || !resolvedConfig) {
        return;
      }
      const devOptions = normalizedDevOptions;

      if (
        devOptions.disableDynamicRemoteTypeHints &&
        devOptions.disableHotTypesReload &&
        devOptions.disableLiveReload
      ) {
        return;
      }

      if (!options.name) {
        throw new Error('name is required if you want to enable dev server!');
      }

      const outputDir = resolveOutputDir(resolvedConfig);
      const normalizedDtsOptions = normalizeDevDtsOptions(options.dts, resolvedConfig.root);

      if (typeof normalizedDtsOptions !== 'object') {
        return;
      }

      const normalizedGenerateTypes = normalizeOptions<moduleFederationPlugin.DtsRemoteOptions>(
        Boolean(normalizedDtsOptions),
        { compileInChildProcess: true },
        'mfOptions.dts.generateTypes'
      )(normalizedDtsOptions.generateTypes);

      const remote =
        normalizedGenerateTypes === false
          ? undefined
          : {
              implementation: normalizedDtsOptions.implementation,
              context: resolvedConfig.root,
              outputDir,
              moduleFederationConfig: {
                ...dtsModuleFederationConfig,
              },
              hostRemoteTypesFolder: normalizedGenerateTypes.typesFolder || '@mf-types',
              ...normalizedGenerateTypes,
              typesFolder: '.dev-server',
            };

      if (
        remote &&
        !remote.tsConfigPath &&
        typeof normalizedDtsOptions === 'object' &&
        normalizedDtsOptions.tsConfigPath
      ) {
        remote.tsConfigPath = normalizedDtsOptions.tsConfigPath;
      }

      const normalizedConsumeTypes = normalizeOptions<moduleFederationPlugin.DtsHostOptions>(
        Boolean(normalizedDtsOptions),
        { consumeAPITypes: true },
        'mfOptions.dts.consumeTypes'
      )(normalizedDtsOptions.consumeTypes);

      const host =
        normalizedConsumeTypes === false
          ? undefined
          : {
              implementation: normalizedDtsOptions.implementation,
              context: resolvedConfig.root,
              moduleFederationConfig: dtsModuleFederationConfig,
              typesFolder: normalizedConsumeTypes.typesFolder || '@mf-types',
              abortOnError: false,
              ...normalizedConsumeTypes,
            };

      const extraOptions = normalizedDtsOptions.extraOptions || {};

      if (!remote && !host && devOptions.disableLiveReload) {
        return;
      }

      const startDevWorker = async () => {
        let remoteTypeUrls: moduleFederationPlugin.RemoteTypeUrls | undefined;
        if (host) {
          remoteTypeUrls = await new Promise((resolve) => {
            consumeTypesAPI(
              {
                host,
                extraOptions,
                displayErrorInTerminal: normalizedDtsOptions.displayErrorInTerminal,
              },
              resolve
            );
          });
        }

        devWorker = new DevWorker({
          name: options.name,
          remote,
          host: host
            ? {
                ...host,
                remoteTypeUrls,
              }
            : undefined,
          extraOptions,
          disableLiveReload: devOptions.disableLiveReload,
          disableHotTypesReload: devOptions.disableHotTypesReload,
        });

        const update = () => devWorker?.update();
        server.watcher.on('change', update);
        server.watcher.on('add', update);
        server.watcher.on('unlink', update);

        server.httpServer?.once('close', () => {
          devWorker?.exit();
          server.watcher.off('change', update);
          server.watcher.off('add', update);
          server.watcher.off('unlink', update);
        });
      };

      startDevWorker().catch((error) => {
        logDtsError(error, normalizedDtsOptions);
      });
    },
  };

  const buildPlugin: Plugin = {
    name: 'module-federation-dts-build',
    apply: 'build',
    configResolved(config) {
      resolvedConfig = config;
    },
    async generateBundle() {
      if (hasGeneratedBundle) {
        return;
      }
      hasGeneratedBundle = true;
      if (!resolvedConfig) {
        return;
      }

      const normalizedDtsOptions = normalizeDtsOptions(
        dtsModuleFederationConfig,
        resolvedConfig.root
      );

      if (typeof normalizedDtsOptions !== 'object') {
        return;
      }

      const context = resolvedConfig.root;
      const outputDir = resolveOutputDir(resolvedConfig);

      const consumeOptions = normalizeConsumeTypesOptions({
        context,
        dtsOptions: normalizedDtsOptions,
        pluginOptions: dtsModuleFederationConfig,
      });

      if (consumeOptions?.host?.typesOnBuild) {
        try {
          await consumeTypesAPI(consumeOptions);
        } catch (error) {
          logDtsError(error, normalizedDtsOptions);
        }
      }

      const generateOptions = normalizeGenerateTypesOptions({
        context,
        outputDir,
        dtsOptions: normalizedDtsOptions,
        pluginOptions: dtsModuleFederationConfig,
      });

      if (!generateOptions) {
        return;
      }

      try {
        await generateTypesAPI({ dtsManagerOptions: generateOptions });
      } catch (error) {
        logDtsError(error, normalizedDtsOptions);
      }
    },
  };

  return [devPlugin, buildPlugin];
}

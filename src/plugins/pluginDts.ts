import fs from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
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
import { hasPackageDependency } from '../utils/packageUtils';
import { createModuleFederationError, mfError } from '../utils/logger';

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

const DEV_TYPES_FOLDER = '.dev-server';
const DEFAULT_PUBLIC_TYPES_FOLDER = '@mf-types';

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
    if (value.import) {
      exposes[key] = value.import;
    }
  });

  const remotes: Record<string, string> = {};
  Object.entries(options.remotes).forEach(([key, remote]) => {
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

const getExposeImportPaths = (options: NormalizedModuleFederationOptions): string[] => {
  return Object.values(options.exposes)
    .map((value) => {
      return value.import;
    })
    .filter((value): value is string => Boolean(value));
};

const usesVueSfcExposes = (options: NormalizedModuleFederationOptions): boolean => {
  return getExposeImportPaths(options).some((value) => value.endsWith('.vue'));
};

export const resolveDtsPluginOptions = (
  dts: NormalizedModuleFederationOptions['dts'],
  options: NormalizedModuleFederationOptions,
  context: string
): NormalizedModuleFederationOptions['dts'] => {
  if (dts === false) {
    return false;
  }

  const inferredGenerateTypesDefaults: moduleFederationPlugin.DtsRemoteOptions = {
    generateAPITypes: true,
  };

  if (usesVueSfcExposes(options) && hasPackageDependency('vue-tsc', context)) {
    inferredGenerateTypesDefaults.compilerInstance = 'vue-tsc';
  }

  if (dts === true || typeof dts === 'undefined') {
    return {
      generateTypes: inferredGenerateTypesDefaults,
    };
  }

  const generateTypes = dts.generateTypes;

  return {
    ...dts,
    generateTypes:
      generateTypes === false
        ? false
        : {
            ...inferredGenerateTypesDefaults,
            ...(generateTypes === true || typeof generateTypes === 'undefined'
              ? {}
              : generateTypes),
          },
  };
};

const getBasePath = (base: string): string => {
  if (base.startsWith('http://') || base.startsWith('https://')) {
    return new URL(base).pathname.replace(/\/$/, '') || '/';
  }
  return base.replace(/\/$/, '') || '/';
};

const joinBaseAndAsset = (base: string, assetFileName: string): string => {
  const basePath = getBasePath(base);
  return `${basePath === '/' ? '' : basePath}/${assetFileName}`.replace(/\/{2,}/g, '/');
};

type DevDtsAssetPaths = {
  apiFilePath: string;
  apiRequestPath: string;
  zipFilePath: string;
  zipRequestPath: string;
};

export const getDevDtsAssetPaths = (options: {
  outputDir: string;
  publicTypesFolder: string;
  root: string;
  base: string;
}): DevDtsAssetPaths => {
  const { outputDir, publicTypesFolder, root, base } = options;

  return {
    apiFilePath: path.resolve(root, outputDir, `${DEV_TYPES_FOLDER}.d.ts`),
    apiRequestPath: joinBaseAndAsset(base, `${publicTypesFolder}.d.ts`),
    zipFilePath: path.resolve(root, outputDir, `${DEV_TYPES_FOLDER}.zip`),
    zipRequestPath: joinBaseAndAsset(base, `${publicTypesFolder}.zip`),
  };
};

export const createDevDtsAssetMiddleware = (assetPaths: DevDtsAssetPaths) => {
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const requestPath = req.url?.split('?')[0];
    const isZipRequest = requestPath === assetPaths.zipRequestPath;
    const isApiRequest = requestPath === assetPaths.apiRequestPath;

    if (!isZipRequest && !isApiRequest) {
      next();
      return;
    }

    const filePath = isZipRequest ? assetPaths.zipFilePath : assetPaths.apiFilePath;
    if (!fs.existsSync(filePath)) {
      res.statusCode = 404;
      res.end();
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', isZipRequest ? 'application/x-gzip' : 'application/typescript');

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) {
        res.statusCode = 500;
      }
      res.end();
    });
    res.on('close', () => {
      stream.destroy();
    });
    stream.pipe(res);
  };
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

const logDtsError = (error: unknown, dtsOptions?: NormalizedModuleFederationOptions['dts']) => {
  if (dtsOptions === false) {
    return;
  }
  if (typeof dtsOptions === 'object' && dtsOptions && dtsOptions.displayErrorInTerminal === false) {
    return;
  }
  mfError(error);
};

export default function pluginDts(options: NormalizedModuleFederationOptions): Plugin[] {
  if (options.dts === false) {
    return [];
  }

  const baseDtsModuleFederationConfig = buildDtsModuleFederationConfig(options);
  const getDtsModuleFederationConfig = (
    context: string
  ): moduleFederationPlugin.ModuleFederationPluginOptions => ({
    ...baseDtsModuleFederationConfig,
    dts: resolveDtsPluginOptions(options.dts, options, context),
  });
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
        throw createModuleFederationError('name is required if you want to enable dev server!');
      }

      const outputDir = resolveOutputDir(resolvedConfig);
      const dtsModuleFederationConfig = getDtsModuleFederationConfig(resolvedConfig.root);
      const normalizedDtsOptions = normalizeDevDtsOptions(
        dtsModuleFederationConfig.dts as NormalizedModuleFederationOptions['dts'],
        resolvedConfig.root
      );

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
              hostRemoteTypesFolder:
                normalizedGenerateTypes.typesFolder || DEFAULT_PUBLIC_TYPES_FOLDER,
              ...normalizedGenerateTypes,
              typesFolder: DEV_TYPES_FOLDER,
            };

      if (remote) {
        server.middlewares.use(
          createDevDtsAssetMiddleware(
            getDevDtsAssetPaths({
              outputDir,
              publicTypesFolder: remote.hostRemoteTypesFolder || DEFAULT_PUBLIC_TYPES_FOLDER,
              root: resolvedConfig.root,
              base: resolvedConfig.base,
            })
          )
        );
      }

      if (remote && !remote.tsConfigPath && normalizedDtsOptions.tsConfigPath) {
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
      let normalizedDtsOptions: moduleFederationPlugin.PluginDtsOptions | false;
      try {
        normalizedDtsOptions = normalizeDtsOptions(
          getDtsModuleFederationConfig(resolvedConfig.root),
          resolvedConfig.root
        );
      } catch (error) {
        logDtsError(error, options.dts);
        return;
      }

      if (typeof normalizedDtsOptions !== 'object') {
        return;
      }

      const context = resolvedConfig.root;
      const outputDir = resolveOutputDir(resolvedConfig);

      let consumeOptions: ReturnType<typeof normalizeConsumeTypesOptions> | undefined;
      try {
        consumeOptions = normalizeConsumeTypesOptions({
          context,
          dtsOptions: normalizedDtsOptions,
          pluginOptions: getDtsModuleFederationConfig(resolvedConfig.root),
        });
      } catch (error) {
        logDtsError(error, normalizedDtsOptions);
        return;
      }

      if (consumeOptions?.host?.typesOnBuild) {
        try {
          await consumeTypesAPI(consumeOptions);
        } catch (error) {
          logDtsError(error, normalizedDtsOptions);
        }
      }

      let generateOptions: ReturnType<typeof normalizeGenerateTypesOptions> | undefined;
      try {
        generateOptions = normalizeGenerateTypesOptions({
          context,
          outputDir,
          dtsOptions: normalizedDtsOptions,
          pluginOptions: getDtsModuleFederationConfig(resolvedConfig.root),
        });
      } catch (error) {
        logDtsError(error, normalizedDtsOptions);
        return;
      }

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

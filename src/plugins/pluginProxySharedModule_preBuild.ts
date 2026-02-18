import { Plugin, ResolvedConfig, UserConfig } from 'vite';
import { mapCodeToCodeWithSourcemap } from '../utils/mapCodeToCodeWithSourcemap';
import { NormalizedShared } from '../utils/normalizeModuleFederationOptions';
import { PromiseStore } from '../utils/PromiseStore';
import VirtualModule, { assertModuleFound } from '../utils/VirtualModule';
import {
  addUsedShares,
  generateLocalSharedImportMap,
  getLoadShareModulePath,
  getLocalSharedImportMapPath,
  PREBUILD_TAG,
  writeLoadShareModule,
  writeLocalSharedImportMap,
  writePreBuildLibPath,
} from '../virtualModules';
import { parsePromise } from './pluginModuleParseEnd';

export function proxySharedModule(options: {
  shared?: NormalizedShared;
  include?: string | string[];
  exclude?: string | string[];
}): Plugin[] {
  const { shared = {} } = options;
  let _config: ResolvedConfig | undefined;
  let _command = 'serve';
  const savePrebuild = new PromiseStore<string>();

  return [
    {
      name: 'generateLocalSharedImportMap',
      enforce: 'post',
      load(id) {
        if (id.includes(getLocalSharedImportMapPath())) {
          return parsePromise.then((_) => generateLocalSharedImportMap());
        }
      },
      transform(_, id) {
        if (id.includes(getLocalSharedImportMapPath())) {
          return mapCodeToCodeWithSourcemap(
            parsePromise.then((_) => generateLocalSharedImportMap())
          );
        }
      },
    },
    {
      name: 'proxyPreBuildShared',
      enforce: 'post',
      config(config: UserConfig, { command }) {
        // Store command for use in configResolved
        _command = command;

        (config.resolve as any).alias.push(
          ...Object.keys(shared).map((key) => {
            const pattern = key.endsWith('/')
              ? `(^${key.replace(/\/$/, '')}(/.+)?$)`
              : `(^${key}$)`;
            return {
              // Intercept all shared requests and proxy them to loadShare
              find: new RegExp(pattern),
              replacement: '$1',
              customResolver(source: string, importer: string) {
                if (/\.css$/.test(source)) return;
                const loadSharePath = getLoadShareModulePath(source);
                writeLoadShareModule(source, shared[key], command);
                writePreBuildLibPath(source);
                addUsedShares(source);
                writeLocalSharedImportMap();
                return (this as any).resolve(loadSharePath, importer);
              },
            };
          })
        );

        (config.resolve as any).alias.push(
          ...Object.keys(shared).map((key) => {
            return command === 'build'
              ? {
                  find: new RegExp(`(.*${PREBUILD_TAG}.*)`),
                  replacement: function ($1: string) {
                    const module = assertModuleFound(PREBUILD_TAG, $1) as VirtualModule;
                    const pkgName = module.name;
                    return pkgName;
                  },
                }
              : {
                  find: new RegExp(`(.*${PREBUILD_TAG}.*)`),
                  replacement: '$1',
                  async customResolver(source: string, importer: string) {
                    const module = assertModuleFound(PREBUILD_TAG, source) as VirtualModule;
                    const pkgName = module.name;
                    const result = await (this as any)
                      .resolve(pkgName, importer)
                      .then((item: any) => item.id);
                    if (_config && !result.includes(_config.cacheDir)) {
                      // save pre-bunding module id
                      savePrebuild.set(pkgName, Promise.resolve(result));
                    }
                    // Fix localSharedImportMap import id
                    return await (this as any).resolve(await savePrebuild.get(pkgName), importer);
                  },
                };
          })
        );
      },
      configResolved(config) {
        _config = config;

        // Eagerly populate usedShares and generate virtual modules AFTER
        // VirtualModule is initialized. This ensures that even if Vite uses
        // the cache (and skips customResolver), the plugin state is correctly
        // initialized.
        Object.keys(shared).forEach((key) => {
          writeLoadShareModule(key, shared[key], _command);
          writePreBuildLibPath(key);
          addUsedShares(key);
        });
        writeLocalSharedImportMap();
      },
    },
  ];
}

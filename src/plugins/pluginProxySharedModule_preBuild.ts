import { Plugin, UserConfig } from 'vite';
import { NormalizedShared } from '../utils/normalizeModuleFederationOptions';
import { PromiseStore } from '../utils/PromiseStore';
import VirtualModule from '../utils/VirtualModule';
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
  let { shared = {}, include, exclude } = options;
  let _config: UserConfig;
  return [
    {
      name: 'generateLocalSharedImportMap',
      enforce: 'post',
      load(id) {
        if (id.includes(getLocalSharedImportMapPath())) {
          return parsePromise.then((_) => generateLocalSharedImportMap());
        }
      },
      transform(code, id) {
        if (id.includes(getLocalSharedImportMapPath())) {
          return parsePromise.then((_) => generateLocalSharedImportMap());
        }
      },
    },
    {
      name: 'proxyPreBuildShared',
      enforce: 'post',
      configResolved(config) {
        _config = config as any;
      },
      config(config: UserConfig, { command }) {
        (config.resolve as any).alias.push(
          ...Object.keys(shared).map((key) => {
            const pattern = key.endsWith('/')
              ? `(^${key.replace(/\/$/, '')}(\/.+)?$)`
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
        const savePrebuild = new PromiseStore<string>();

        (config.resolve as any).alias.push(
          ...Object.keys(shared).map((key) => {
            return command === 'build'
              ? {
                  find: new RegExp(`(.*${PREBUILD_TAG}.*)`),
                  replacement: function ($1: string) {
                    const pkgName = (VirtualModule.findModule(PREBUILD_TAG, $1) as VirtualModule)
                      .name;
                    return pkgName;
                  },
                }
              : {
                  find: new RegExp(`(.*${PREBUILD_TAG}.*)`),
                  replacement: '$1',
                  async customResolver(source: string, importer: string) {
                    const pkgName = (
                      VirtualModule.findModule(PREBUILD_TAG, source) as VirtualModule
                    ).name;
                    const result = await (this as any)
                      .resolve(pkgName, importer)
                      .then((item: any) => item.id);
                    if (!result.includes(_config.cacheDir)) {
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
    },
  ];
}

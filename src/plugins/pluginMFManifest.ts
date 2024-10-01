import { join, relative } from 'pathe';
import { Manifest, Plugin } from 'vite';
import {
  getNormalizeModuleFederationOptions,
  getNormalizeShareItem,
} from '../utils/normalizeModuleFederationOptions';
import { getPreBuildLibImportId, getUsedRemotesMap, getUsedShares } from '../virtualModules';

const Manifest = (): Plugin[] => {
  const mfOptions = getNormalizeModuleFederationOptions();
  const { name, filename, getPublicPath, manifest: manifestOptions } = mfOptions;
  let mfManifestName: string = '';
  if (manifestOptions === true) {
    mfManifestName = 'mf-manifest.json';
  }
  if (typeof manifestOptions !== 'boolean') {
    mfManifestName = join(manifestOptions?.filePath || '', manifestOptions?.fileName || '');
  }
  let extensions: string[];
  let root: string;
  type PreloadMap = Record<
    string,
    {
      sync: string[];
      async: string[];
    }
  >; // 保存模块和文件的映射关系
  let remoteEntryFile: string;
  let publicPath: string;
  let _command: string;
  return [
    {
      name: 'module-federation-manifest',
      apply: 'serve',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (!mfManifestName) {
            next();
            return;
          }
          if (req.url === mfManifestName.replace(/^\/?/, '/')) {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.end(
              JSON.stringify({
                ...generateMFManifest({}),
                id: name,
                name: name,
                metaData: {
                  name: name,
                  type: 'app',
                  buildInfo: { buildVersion: '1.0.0', buildName: name },
                  remoteEntry: {
                    name: filename,
                    path: '',
                    type: 'module',
                  },
                  ssrRemoteEntry: {
                    name: filename,
                    path: '',
                    type: 'module',
                  },
                  types: { path: '', name: '' },
                  globalName: name,
                  pluginVersion: '0.2.5',
                  ...(!!getPublicPath ? { getPublicPath } : { publicPath }),
                },
              })
            );
          } else {
            next();
          }
        });
      },
    },
    {
      name: 'module-federation-manifest',
      enforce: 'post',
      config(config, { command }) {
        if (!config.build) config.build = {};
        if (!config.build.manifest)
          config.build.manifest = config.build.manifest || !!manifestOptions;
        _command = command;
      },
      configResolved(config) {
        root = config.root;
        extensions = config.resolve.extensions || [
          '.mjs',
          '.js',
          '.mts',
          '.ts',
          '.jsx',
          '.tsx',
          '.json',
        ];
        publicPath = config.base ? config.base.replace(/\/?$/, '/') : 'auto';
        if (_command === 'serve') {
          const origin = config.server.origin;
          publicPath = origin ? origin.replace(/\/?$/, '/') : 'auto';
        }
      },
      async generateBundle(options, bundle) {
        if (!mfManifestName) return;

        const exposesModules = Object.keys(mfOptions.exposes).map(
          (item) => mfOptions.exposes[item].import
        ); // 获取你提供的 moduleIds
        const filesContainingModules: PreloadMap = {};
        // 帮助函数：检查模块路径是否匹配
        const isModuleMatched = (relativeModulePath: string, preloadModule: string) => {
          // 先尝试直接匹配
          if (relativeModulePath === preloadModule) return true;
          // 如果 preloadModule 没有后缀，尝试添加可能的后缀进行匹配
          for (const ext of extensions) {
            if (relativeModulePath === `${preloadModule}${ext}`) {
              return true;
            }
          }
          return false;
        };

        // 遍历打包生成的每个文件
        for (const [fileName, fileData] of Object.entries(bundle)) {
          if (
            mfOptions.filename.replace(/[\[\]]/g, '_') === fileData.name ||
            fileData.name === 'remoteEntry'
          ) {
            remoteEntryFile = fileData.fileName;
          }
          if (fileData.type === 'chunk') {
            // 遍历该文件的所有模块
            for (const modulePath of Object.keys(fileData.modules)) {
              // 将绝对路径转换为相对于 Vite root 的相对路径
              const relativeModulePath = relative(root, modulePath);

              // 检查模块是否在 preloadModules 列表中
              for (const preloadModule of exposesModules) {
                const formatPreloadModule = preloadModule.replace('./', '');
                if (isModuleMatched(relativeModulePath, formatPreloadModule)) {
                  if (!filesContainingModules[preloadModule]) {
                    filesContainingModules[preloadModule] = {
                      sync: [],
                      async: [],
                    };
                  }
                  console.log(Object.keys(fileData.modules));
                  filesContainingModules[preloadModule].sync.push(fileName);
                  filesContainingModules[preloadModule].async.push(
                    ...(fileData.dynamicImports || [])
                  );
                  findSynchronousImports(fileName, filesContainingModules[preloadModule].sync);
                  break; // 如果找到匹配，跳出循环
                }
              }
            }
          }
        }
        // 递归查找模块的同步导入文件
        function findSynchronousImports(fileName: string, array: string[]) {
          const fileData = bundle[fileName];
          if (fileData && fileData.type === 'chunk') {
            array.push(fileName); // 将当前文件加入预加载列表

            // 遍历该文件的同步导入文件
            fileData.imports.forEach((importedFile) => {
              if (array.indexOf(importedFile) === -1) {
                findSynchronousImports(importedFile, array); // 递归查找同步导入的文件
              }
            });
          }
        }
        const fileToShareKey: Record<string, string> = {};
        await Promise.all(
          Array.from(getUsedShares()).map(async (shareKey) => {
            const file = (await (this as any).resolve(getPreBuildLibImportId(shareKey))).id.split(
              '?'
            )[0];
            fileToShareKey[file] = shareKey;
          })
        );

        // 遍历打包生成的每个文件
        for (const [fileName, fileData] of Object.entries(bundle)) {
          if (fileData.type === 'chunk') {
            // 遍历该文件的所有模块
            for (const modulePath of Object.keys(fileData.modules)) {
              const sharedKey = fileToShareKey[modulePath];
              if (sharedKey) {
                if (!filesContainingModules[sharedKey]) {
                  filesContainingModules[sharedKey] = {
                    sync: [],
                    async: [],
                  };
                }
                filesContainingModules[sharedKey].sync.push(fileName);
                filesContainingModules[sharedKey].async.push(...(fileData.dynamicImports || []));
                findSynchronousImports(fileName, filesContainingModules[sharedKey].sync);
                break; // 如果找到匹配，跳出循环
              }
            }
          }
        }
        Object.keys(filesContainingModules).forEach((key) => {
          filesContainingModules[key].sync = Array.from(new Set(filesContainingModules[key].sync));
          filesContainingModules[key].async = Array.from(
            new Set(filesContainingModules[key].async)
          );
        });
        this.emitFile({
          type: 'asset',
          fileName: mfManifestName,
          source: JSON.stringify(generateMFManifest(filesContainingModules)),
        });
      },
    },
  ];
  function generateMFManifest(preloadMap: PreloadMap) {
    const options = getNormalizeModuleFederationOptions();
    const { name } = options;
    const remoteEntry = {
      name: remoteEntryFile,
      path: '',
      type: 'module',
    };
    const remotes: {
      federationContainerName: string;
      moduleName: string;
      alias: string;
      entry: string;
    }[] = [];
    const usedRemotesMap = getUsedRemotesMap();
    Object.keys(usedRemotesMap).forEach((remoteKey) => {
      const usedModules = Array.from(usedRemotesMap[remoteKey]);
      usedModules.forEach((moduleKey) => {
        remotes.push({
          federationContainerName: options.remotes[remoteKey].entry,
          moduleName: moduleKey.replace(remoteKey, '').replace('/', ''),
          alias: remoteKey,
          entry: '*',
        });
      });
    });
    type ManifestItem = {
      id: string;
      name: string;
      version: string;
      requiredVersion: string;
      assets: {
        js: {
          async: string[];
          sync: string[];
        };
        css: {
          async: string[];
          sync: string[];
        };
      };
    };
    // @ts-ignore
    const shared: ManifestItem[] = Array.from(getUsedShares())
      .map((shareKey) => {
        const shareItem = getNormalizeShareItem(shareKey);

        return {
          id: `${name}:${shareKey}`,
          name: shareKey,
          version: shareItem.version,
          requiredVersion: shareItem.shareConfig.requiredVersion,
          assets: {
            js: {
              async: preloadMap?.[shareKey]?.async || [],
              sync: preloadMap?.[shareKey]?.sync || [],
            },
            css: {
              async: [],
              sync: [],
            },
          },
        };
      })
      .filter((item) => item);
    const exposes = Object.keys(options.exposes)
      .map((key) => {
        // assets(.css, .jpg, .svg等)其他资源, 不重要, 暂未处理
        const formatKey = key.replace('./', '');
        const sourceFile = options.exposes[key].import;
        return {
          id: name + ':' + formatKey,
          name: formatKey,
          assets: {
            js: {
              async: preloadMap?.[sourceFile]?.async || [],
              sync: preloadMap?.[sourceFile]?.sync || [],
            },
            css: {
              sync: [],
              async: [],
            },
          },
          path: key,
        };
      })
      .filter((item) => item); // Filter out any null values

    const result = {
      id: name,
      name: name,
      metaData: {
        name: name,
        type: 'app',
        buildInfo: {
          buildVersion: '1.0.0',
          buildName: name,
        },
        remoteEntry,
        ssrRemoteEntry: remoteEntry,
        types: {
          path: '',
          name: '',
          // "zip": "@mf-types.zip",
          // "api": "@mf-types.d.ts"
        },
        globalName: name,
        pluginVersion: '0.2.5',
        ...(!!getPublicPath ? { getPublicPath } : { publicPath }),
      },
      shared,
      remotes,
      exposes,
    };
    return result;
  }
};

export default Manifest;

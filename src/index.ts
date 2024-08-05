import { createFilter } from '@rollup/pluginutils';
import { Alias, Plugin, UserConfig } from 'vite';
import aliasToArrayPlugin from './utils/aliasToArrayPlugin';
import normalizeBuildPlugin from './utils/normalizeBuild';
import {
  ModuleFederationOptions,
  NormalizedModuleFederationOptions,
  NormalizedShared,
  normalizeModuleFederationOptions,
} from './utils/normalizeModuleFederationOptions';
import normalizeOptimizeDepsPlugin from './utils/normalizeOptimizeDeps';
import addEntry from './utils/vitePluginAddEntry';
import { overrideModule } from './utils/vitePluginOverrideModule';
const emptyPath = require.resolve('an-empty-js-file');

const filter: (id: string) => boolean = createFilter();

let command: string = '';
function wrapRemoteEntry(): string {
  return `
  import {init, get} from "__mf__cwdRemoteEntry"
  export {init, get}
  `;
}
function wrapHostInit(): string {
  return `
    import {init} from "__mf__cwdRemoteEntry"
    init()
    `;
}
function generateRemoteEntry(options: NormalizedModuleFederationOptions): string {
  const pluginImportNames = options.runtimePlugins.map((p, i) => [
    `$runtimePlugin_${i}`,
    `import $runtimePlugin_${i} from "${p}";`,
  ]);

  return `
  import {init as runtimeInit, loadRemote} from "@module-federation/runtime";
  
  ${pluginImportNames.map((item) => item[1]).join('\n')}

  const exposesMap = {
    ${Object.keys(options.exposes)
      .map((key) => {
        return `
        ${JSON.stringify(key)}: async () => {
          const importModule = await import(${JSON.stringify(options.exposes[key].import)})
          const exportModule = {}
          Object.assign(exportModule, importModule)
          Object.defineProperty(exportModule, "__esModule", {
            value: true,
            enumerable: false
          })
          return exportModule
        }
      `;
      })
      .join(',')}
  }
  async function init(shared = {}) {
    const localShared = {
      ${Object.keys(options.shared)
        .map((key) => {
          const shareItem = options.shared[key];
          return `
          ${JSON.stringify(key)}: {
            name: ${JSON.stringify(shareItem.name)},
            version: ${JSON.stringify(shareItem.version)},
            scope: [${JSON.stringify(shareItem.scope)}],
            loaded: false,
            from: ${JSON.stringify(options.name)},
            async get () {
              localShared[${JSON.stringify(key)}].loaded = true
              const pkg = await import(${JSON.stringify(key)})
              return function () {
                return pkg
              }
            },
            shareConfig: {
              singleton: ${shareItem.shareConfig.singleton},
              requiredVersion: ${JSON.stringify(shareItem.shareConfig.requiredVersion)}
            }
          }
        `;
        })
        .join(',')}
    }
    const initRes = runtimeInit({
      name: ${JSON.stringify(options.name)},
      remotes: [${Object.keys(options.remotes)
        .map((key) => {
          const remote = options.remotes[key];
          return `
                {
                  entryGlobalName: ${JSON.stringify(remote.entryGlobalName)},
                  name: ${JSON.stringify(remote.name)},
                  type: ${JSON.stringify(remote.type)},
                  entry: ${JSON.stringify(remote.entry)},
                }
          `;
        })
        .join(',')}
      ],
      shared: localShared,
      plugins: [${pluginImportNames.map((item) => `${item[0]}()`).join(', ')}]
    });
    initRes.initShareScopeMap('${options.shareScope}', shared);
    return initRes
  }

  function getExposes(moduleName) {
    if (!(moduleName in exposesMap)) throw new Error(\`Module \${moduleName} does not exist in container.\`)
    return (exposesMap[moduleName])().then(res => () => res)
  }
  export {
      init,
      getExposes as get
  }
  `;
}

function wrapShare(
  id: string,
  shared: NormalizedShared
): { code: string; map: null; syntheticNamedExports: string } {
  const shareConfig = shared[id].shareConfig;
  return {
    code: `
        import {loadShare} from "@module-federation/runtime"
        const res = await loadShare(${JSON.stringify(id)}, {
        customShareInfo: {shareConfig:{
          singleton: ${shareConfig.singleton},
          strictVersion: ${JSON.stringify(shareConfig.strictVersion)},
          requiredVersion: ${JSON.stringify(shareConfig.requiredVersion)}
        }}})
        export default res()
      `,
    map: null,
    syntheticNamedExports: 'default',
  };
}

let con: UserConfig;
function wrapRemote(id: string): { code: string; map: null; syntheticNamedExports: string } {
  return {
    code: `
    import {loadRemote} from "@module-federation/runtime"
    export ${
      command !== 'build' ? 'default' : 'const dynamicExport = '
    } await loadRemote(${JSON.stringify(id)})
  `,
    map: null,
    syntheticNamedExports: 'dynamicExport',
  };
}

function federation(mfUserOptions: ModuleFederationOptions): Plugin[] {
  const options = normalizeModuleFederationOptions(mfUserOptions);
  const { remotes, shared, filename } = options;

  const alias: Alias[] = [
    {
      find: '@module-federation/runtime',
      replacement: require.resolve('@module-federation/runtime'),
    },
  ];

  Object.keys(remotes).forEach((key) => {
    const remote = remotes[key];
    alias.push({
      find: new RegExp(`(${remote.name}(\/.*|$)?)`),
      replacement: '$1',
      customResolver(source) {
        if (!con.optimizeDeps) con.optimizeDeps = {};
        if (!con.optimizeDeps.needsInterop) con.optimizeDeps.needsInterop = [];
        if (con.optimizeDeps.needsInterop.indexOf(source) === -1)
          con.optimizeDeps.needsInterop.push(source);
        return this.resolve(
          require.resolve('an-empty-js-file') + '?__moduleRemote__=' + encodeURIComponent(source)
        );
      },
    });
  });

  const remotePrefixList = Object.keys(remotes);
  // pkgname will be escaped, and matching path also needs to be processed in the same way:
  // @json2csv/plainjs --> .vite/deps/@json2csv_plainjs
  const sharedKeyMatchList = Object.keys(shared).map(
    (item) => `__overrideModule__${item.replace('/', '_')}`
  );

  return [
    aliasToArrayPlugin,
    normalizeOptimizeDepsPlugin,
    normalizeBuildPlugin([...Object.keys(shared), "@module-federation/runtime"]),
    ...addEntry({
      entryName: 'remoteEntry',
      entryPath: emptyPath + '?__mf__wrapRemoteEntry__',
      fileName: filename,
    }),
    ...addEntry({
      entryName: 'hostInit',
      entryPath: emptyPath + '?__mf__isHostInit',
    }),
    overrideModule({
      override: Object.keys(shared),
    }),
    {
      name: 'module-federation-vite',
      enforce: 'post',
      config(config, { command: _command }: { command: string }) {
        con = config;
        command = _command;
        (config.resolve as any).alias.push(...alias);
        config.optimizeDeps?.include?.push('@module-federation/runtime');
        Object.keys(shared).forEach((key) => {
          config.optimizeDeps?.include?.push(key);
        });
      },
      resolveId(id: string) {
        if (id === '__mf__cwdRemoteEntry') {
          return '__mf__cwdRemoteEntry';
        }
      },
      load(id: string) {
        if (id === '__mf__cwdRemoteEntry') {
          return generateRemoteEntry(options);
        }
      },
      async transform(code: string, id: string) {
        if (!filter(id)) return;
        if (id === '__mf__cwdRemoteEntry') {
          return generateRemoteEntry(options);
        }
        if (id.indexOf('__mf__wrapRemoteEntry__') > -1) {
          return wrapRemoteEntry();
        }
        if (id.indexOf('__mf__isHostInit') > -1) {
          return wrapHostInit();
        }
        if (id.indexOf('__mf__cwdRemoteEntry') > -1) {
          return generateRemoteEntry(options);
        }
        let [devSharedModuleName] =
          (sharedKeyMatchList.length &&
            id.match(new RegExp(`\/(${sharedKeyMatchList.join('|')})(\_.*\.js|\.js)`))) ||
          [];
        if (devSharedModuleName) {
          return wrapShare(
            devSharedModuleName
              .replace('/__overrideModule__', '')
              .replace(/_/g, '/')
              .replace('.js', ''),
            shared
          );
        }
        let [prodSharedName] = id.match(/\_\_overrideModule\_\_=[^&]+/) || [];
        if (prodSharedName) {
          return wrapShare(
            decodeURIComponent(prodSharedName.replace('__overrideModule__=', '')),
            shared
          );
        }
        let [devRemoteModuleName] =
          (remotePrefixList.length &&
            id.match(new RegExp(`\/(${remotePrefixList.join('|')})(\_.*\.js|\.js)`))) ||
          [];
        if (devRemoteModuleName) {
          return wrapRemote(
            devRemoteModuleName.replace('/', '').replace(/_/g, '/').replace('.js', '')
          );
        }
        let [prodRemoteName] = id.match(/\_\_moduleRemote\_\_=[^&]+/) || [];
        if (prodRemoteName) {
          return wrapRemote(decodeURIComponent(prodRemoteName.replace('__moduleRemote__=', '')));
        }
      },
    },
  ];
}

export { federation };
export default federation
import { createFilter } from '@rollup/pluginutils';
import { Alias, Plugin, UserConfig } from "vite";
import aliasToArrayPlugin from "./utils/aliasToArrayPlugin";
import normalizeBuildPlugin from "./utils/normalizeBuild";
import { ModuleFederationOptions, NormalizedModuleFederationOptions, NormalizedShared, normalizeModuleFederationOptions } from "./utils/normalizeModuleFederationOptions";
import normalizeOptimizeDepsPlugin from "./utils/normalizeOptimizeDeps";
import addEntry from "./utils/vitePluginAddEntry";
import { overrideModule } from "./utils/vitePluginOverrideModule";
const emptyPath = require.resolve("an-empty-js-file");

const filter: (id: string) => boolean = createFilter();

let command: string = "";
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
  return `
  import {init as runtimeInit, loadRemote} from "@module-federation/runtime"

  const exposesMap = {
    ${Object.keys(options.exposes).map(key => {
    return `
      ${key}: () => import(${JSON.stringify(options.exposes[key].import)})
      `;
  }).join(",")}
  }
  async function init(shared = {}) {
    const localShared = {
      ${Object.keys(options.shared).map(key => {
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
  }).join(",")}
    }
    const initRes = await runtimeInit({
      name: ${JSON.stringify(options.name)},
      remotes: [${Object.keys(options.remotes).map(key => {
    const remote = options.remotes[key];
    return `
                {
                  entryGlobalName: ${JSON.stringify(remote.entryGlobalName)},
                  name: ${JSON.stringify(remote.name)},
                  type: ${JSON.stringify(remote.type)},
                  entry: ${JSON.stringify(remote.entry)},
                }
          `;
  }).join(",")}
      ],
      shared: localShared
    });
    initRes.initShareScopeMap('${options.shareScope}', shared);
    return initRes
  }

  function getExposes(moduleName) {
    moduleName = moduleName.replace(/(^\\.\\/)?/, "")
    if (!(moduleName in exposesMap)) throw new Error(\`Module ./\${moduleName} does not exist in container.\`)
    return (exposesMap[moduleName])().then(res => () => res)
  }
  export {
      init,
      getExposes as get
  }
  `;
}

function wrapShare(id: string, shared: NormalizedShared): { code: string, map: null, syntheticNamedExports: string } {
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
        export ${command !== "build" ? "default" : "const dynamicExport = "} res()
      `,
    map: null,
    syntheticNamedExports: "dynamicExport"
  };
}

let con: UserConfig;
function wrapRemote(id: string): { code: string, map: null, syntheticNamedExports: string } {
  return {
    code: `
    import {loadRemote} from "@module-federation/runtime"
    export ${command !== "build" ? "default" : "const dynamicExport = "} await loadRemote(${JSON.stringify(id)})
  `,
    map: null,
    syntheticNamedExports: "dynamicExport"
  };
}

function federation(
  mfUserOptions: ModuleFederationOptions
): Plugin[] {
  const options = normalizeModuleFederationOptions(mfUserOptions);
  const {
    remotes,
    shared,
    filename,
  } = options;

  const alias: Alias[] = [
    { find: "@module-federation/runtime", replacement: require.resolve("@module-federation/runtime") }
  ];

  Object.keys(remotes).forEach(key => {
    const remote = remotes[key];
    alias.push({
      find: new RegExp(`(${remote.name}(\/.*|$)?)`),
      replacement: "$1",
      customResolver(source) {
        if (!con.optimizeDeps) con.optimizeDeps = {};
        if (!con.optimizeDeps.needsInterop) con.optimizeDeps.needsInterop = [];
        if (con.optimizeDeps.needsInterop.indexOf(source) === -1) con.optimizeDeps.needsInterop.push(source);
        return this.resolve(require.resolve("an-empty-js-file") + "?__moduleRemote__=" + encodeURIComponent(source));
      }
    });
  });

  const remotePrefixList = Object.keys(remotes);
  const sharedKeyList = Object.keys(shared).map(item => `__overrideModule__${item}`);

  return [
    aliasToArrayPlugin,
    normalizeOptimizeDepsPlugin,
    normalizeBuildPlugin(shared),
    addEntry({ entryName: "remoteEntry", entryPath: emptyPath + "?__mf__wrapRemoteEntry__", fileName: filename }),
    addEntry({ entryName: "hostInit", entryPath: emptyPath + "?__mf__isHostInit", fileName: "hostInit.js" }),
    overrideModule({
      override: Object.keys(shared)
    }),
    {
      name: "module-federation-vite",
      enforce: "post",
      config(config, { command: _command }: { command: string }) {
        con = config;
        command = _command;
        (config.resolve as any).alias.push(...alias);
        config.optimizeDeps?.include?.push("@module-federation/runtime");
        Object.keys(shared).forEach(key => {
          config.optimizeDeps?.include?.push(key);
        });
      },
      resolveId(id: string) {
        if (id === "__mf__cwdRemoteEntry") {
          return "__mf__cwdRemoteEntry";
        }
      },
      load(id: string) {
        if (id === "__mf__cwdRemoteEntry") {
          return generateRemoteEntry(options);
        }
      },
      async transform(code: string, id: string) {
        if (!filter(id)) return;
        if (id === "__mf__cwdRemoteEntry") {
          return generateRemoteEntry(options);
        }
        if (id.indexOf("__mf__wrapRemoteEntry__") > -1) {
          return wrapRemoteEntry();
        }
        if (id.indexOf("__mf__isHostInit") > -1) {
          return wrapHostInit();
        }
        if (id.indexOf("__mf__cwdRemoteEntry") > -1) {
          return generateRemoteEntry(options);
        }
        let [devSharedModuleName] = id.match(new RegExp(`\.vite\/deps\/(${sharedKeyList.join("|")})(\_.*\.js|\.js)`)) || [];
        if (devSharedModuleName) {
          return wrapShare(devSharedModuleName.replace(".vite/deps/__overrideModule__", "").replace(/_/g, "/").replace(".js", ""), shared);
        }
        let [prodSharedName] = id.match(/\_\_overrideModule\_\_=[^&]+/) || [];
        if (prodSharedName) {
          return wrapShare(decodeURIComponent(prodSharedName.replace("__overrideModule__=", "")), shared);
        }
        let [devRemoteModuleName] = id.match(new RegExp(`\.vite\/deps\/(${remotePrefixList.join("|")})(\_.*\.js|\.js)`)) || [];
        if (devRemoteModuleName) {
          return wrapRemote(devRemoteModuleName.replace(".vite/deps/", "").replace(/_/g, "/").replace(".js", ""));
        }
        let [prodRemoteName] = id.match(/\_\_moduleRemote\_\_=[^&]+/) || [];
        if (prodRemoteName) {
          return wrapRemote(decodeURIComponent(prodRemoteName.replace("__moduleRemote__=", "")));
        }
      },
    }
  ];
};

export {
  federation
};
export default federation
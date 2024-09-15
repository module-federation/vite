import * as fs from 'fs';
import { mkdirSync, writeFileSync, existsSync, writeFile } from 'fs';
import * as path from 'pathe';
import path__default, { parse, join, dirname, resolve, relative } from 'pathe';
import { createFilter } from '@rollup/pluginutils';
import { walk } from 'estree-walker';
import MagicString from 'magic-string';
import { defu } from 'defu';

const addEntry = ({
  entryName,
  entryPath,
  fileName
}) => {
  const devEntryPath = entryPath.startsWith("virtual:mf") ? "/@id/" + entryPath : entryPath;
  let entryFiles = [];
  let htmlFilePath;
  let _command;
  return [{
    name: 'add-entry',
    apply: "serve",
    config(config, {
      command
    }) {
      _command = command;
    },
    configureServer(server) {
      var _server$httpServer;
      (_server$httpServer = server.httpServer) == null || _server$httpServer.once == null || _server$httpServer.once('listening', () => {
        const {
          port
        } = server.config.server;
        fetch(path.join(`http://localhost:${port}`, `${devEntryPath}`)).catch(e => {});
      });
      server.middlewares.use((req, res, next) => {
        if (!fileName) {
          next();
          return;
        }
        if (req.url && req.url.startsWith(fileName.replace(/^\/?/, '/'))) {
          req.url = devEntryPath;
        }
        next();
      });
    },
    transformIndexHtml(c) {
      return c.replace('<head>', `<head><script type="module" src=${JSON.stringify(devEntryPath.replace(/.+?\:([/\\])[/\\]?/, '$1').replace(/\\\\?/g, '/'))}></script>`);
    }
  }, {
    name: "add-entry",
    enforce: "post",
    configResolved(config) {
      const inputOptions = config.build.rollupOptions.input;
      if (!inputOptions) {
        htmlFilePath = path.resolve(config.root, 'index.html');
      } else if (typeof inputOptions === 'string') {
        entryFiles = [inputOptions];
        htmlFilePath = path.resolve(config.root, inputOptions);
      } else if (Array.isArray(inputOptions)) {
        entryFiles = inputOptions;
        htmlFilePath = path.resolve(config.root, inputOptions[0]);
      } else if (typeof inputOptions === 'object') {
        entryFiles = Object.values(inputOptions);
        htmlFilePath = path.resolve(config.root, Object.values(inputOptions)[0]);
      }
    },
    buildStart() {
      if (_command === "serve") return;
      const hasHash = fileName == null || fileName.includes == null ? void 0 : fileName.includes("[hash");
      this.emitFile({
        name: entryName,
        [hasHash ? "name" : "fileName"]: fileName,
        type: 'chunk',
        id: entryPath,
        preserveSignature: 'strict'
      });
      if (htmlFilePath) {
        const htmlContent = fs.readFileSync(htmlFilePath, 'utf-8');
        const scriptRegex = /<script\s+[^>]*src=["']([^"']+)["'][^>]*>/gi;
        let match;
        while ((match = scriptRegex.exec(htmlContent)) !== null) {
          entryFiles.push(match[1]);
        }
      }
    },
    transform(code, id) {
      if (entryFiles.some(file => id.endsWith(file))) {
        const injection = `
          import ${JSON.stringify(entryPath)};
          `;
        return injection + code;
      }
    }
  }];
};

/**
 * Solve the problem that dev mode dependency prebunding does not support top-level await syntax
 */
function PluginDevProxyModuleTopLevelAwait() {
  const filterFunction = createFilter();
  return {
    name: "dev-proxy-module-top-level-await",
    apply: "serve",
    transform(code, id) {
      if (!code.includes("/*mf top-level-await placeholder replacement mf*/")) {
        return null;
      }
      if (!filterFunction(id)) return null;
      let ast;
      try {
        ast = this.parse(code, {
          allowReturnOutsideFunction: true
        });
      } catch (e) {
        throw new Error(`${id}: ${e}`);
      }
      const magicString = new MagicString(code);
      walk(ast, {
        enter(node) {
          if (node.type === 'ExportNamedDeclaration' && node.specifiers) {
            const exportSpecifiers = node.specifiers.map(specifier => specifier.exported.name);
            const proxyStatements = exportSpecifiers.map(name => `
              const __mfproxy__await${name} = await ${name}();
              const __mfproxy__${name} = () => __mfproxy__await${name};
            `).join('\n');
            const exportStatements = exportSpecifiers.map(name => `__mfproxy__${name} as ${name}`).join(', ');
            const start = node.start;
            const end = node.end;
            const replacement = `${proxyStatements}\nexport { ${exportStatements} };`;
            magicString.overwrite(start, end, replacement);
          }
          if (node.type === 'ExportDefaultDeclaration') {
            const declaration = node.declaration;
            const start = node.start;
            const end = node.end;
            let proxyStatement;
            let exportStatement = 'default';
            if (declaration.type === 'Identifier') {
              // example: export default foo;
              proxyStatement = `
                const __mfproxy__awaitdefault = await ${declaration.name}();
                const __mfproxy__default = __mfproxy__awaitdefault;
              `;
            } else if (declaration.type === 'CallExpression' || declaration.type === 'FunctionDeclaration') {
              // example: export default someFunction();
              const declarationCode = code.slice(declaration.start, declaration.end);
              proxyStatement = `
                const __mfproxy__awaitdefault = await (${declarationCode});
                const __mfproxy__default = __mfproxy__awaitdefault;
              `;
            } else {
              // other
              proxyStatement = `
                const __mfproxy__awaitdefault = await (${code.slice(declaration.start, declaration.end)});
                const __mfproxy__default = __mfproxy__awaitdefault;
              `;
            }
            const replacement = `${proxyStatement}\nexport { __mfproxy__default as ${exportStatement} };`;
            magicString.overwrite(start, end, replacement);
          }
        }
      });
      return {
        code: magicString.toString(),
        map: magicString.generateMap({
          hires: true
        })
      };
    }
  };
}

function normalizeExposesItem(key, item) {
  let importPath = '';
  if (typeof item === 'string') {
    importPath = item;
  }
  if (typeof item === 'object') {
    importPath = item.import;
  }
  return {
    import: importPath
  };
}
function normalizeExposes(exposes) {
  if (!exposes) return {};
  const res = {};
  Object.keys(exposes).forEach(key => {
    res[key] = normalizeExposesItem(key, exposes[key]);
  });
  return res;
}
function normalizeRemotes(remotes) {
  if (!remotes) return {};
  const result = {};
  if (typeof remotes === 'object') {
    Object.keys(remotes).forEach(key => {
      result[key] = normalizeRemoteItem(key, remotes[key]);
    });
  }
  return result;
}
function normalizeRemoteItem(key, remote) {
  if (typeof remote === 'string') {
    const [entryGlobalName] = remote.split('@');
    const entry = remote.replace(entryGlobalName + '@', '');
    return {
      type: 'var',
      name: key,
      entry,
      entryGlobalName,
      shareScope: 'default'
    };
  }
  return Object.assign({
    type: 'var',
    name: key,
    shareScope: 'default',
    entryGlobalName: key
  }, remote);
}
function removePathFromNpmPackage(packageString) {
  // 匹配npm包名的正则表达式，忽略路径部分
  const regex = /^(?:@[^/]+\/)?[^/]+/;
  // 使用正则表达式匹配并提取包名
  const match = packageString.match(regex);
  // 返回匹配到的包名，如果没有匹配到则返回原字符串
  return match ? match[0] : packageString;
}
function normalizeShareItem(key, shareItem) {
  let version;
  try {
    version = require(path.join(removePathFromNpmPackage(key), 'package.json')).version;
  } catch (e) {
    console.log(e);
  }
  if (typeof shareItem === 'string') {
    return {
      name: shareItem,
      version,
      scope: 'default',
      from: '',
      shareConfig: {
        singleton: false,
        requiredVersion: `^${version}` || '*'
      }
    };
  }
  return {
    name: key,
    from: '',
    version: shareItem.version || version,
    scope: shareItem.shareScope || 'default',
    shareConfig: {
      singleton: shareItem.singleton || false,
      requiredVersion: shareItem.requiredVersion || `^${version}` || '*',
      strictVersion: !!shareItem.strictVersion
    }
  };
}
function normalizeShared(shared) {
  if (!shared) return {};
  const result = {};
  if (Array.isArray(shared)) {
    shared.forEach(key => {
      result[key] = normalizeShareItem(key, key);
    });
    return result;
  }
  if (typeof shared === 'object') {
    Object.keys(shared).forEach(key => {
      result[key] = normalizeShareItem(key, shared[key]);
    });
  }
  return result;
}
function normalizeLibrary(library) {
  if (!library) return undefined;
  return library;
}
function normalizeManifest(manifest = false) {
  if (typeof manifest === "boolean") {
    return manifest;
  }
  return Object.assign({
    filePath: "",
    disableAssetsAnalyze: false,
    fileName: "mf-manifest.json"
  }, manifest);
}
let config;
function getNormalizeModuleFederationOptions() {
  return config;
}
function getNormalizeShareItem(key) {
  const options = getNormalizeModuleFederationOptions();
  const shareItem = options.shared[removePathFromNpmPackage(key)] || options.shared[removePathFromNpmPackage(key) + "/"];
  return shareItem;
}
function normalizeModuleFederationOptions(options) {
  return config = {
    exposes: normalizeExposes(options.exposes),
    filename: options.filename || 'remoteEntry-[hash]',
    library: normalizeLibrary(options.library),
    name: options.name,
    // remoteType: options.remoteType,
    remotes: normalizeRemotes(options.remotes),
    runtime: options.runtime,
    shareScope: options.shareScope || 'default',
    shared: normalizeShared(options.shared),
    runtimePlugins: options.runtimePlugins || [],
    getPublicPath: options.getPublicPath,
    implementation: options.implementation,
    manifest: normalizeManifest(options.manifest),
    dev: options.dev,
    dts: options.dts
  };
}

/**
 * Escaping rules:
 * Convert using the format __${mapping}__, where _ and $ are not allowed in npm package names but can be used in variable names.
 *  @ => 1
 *  / => 2
 *  - => 3
 *  . => 4
 */
/**
 * Encodes a package name into a valid file name.
 * @param {string} name - The package name, e.g., "@scope/xx-xx.xx".
 * @returns {string} - The encoded file name.
 */
function packageNameEncode(name) {
  if (typeof name !== "string") throw new Error("A string package name is required");
  return name.replace(/@/g, "_mf_0_").replace(/\//g, "_mf_1_").replace(/-/g, "_mf_2_").replace(/\./g, "_mf_3_");
}
/**
 * Decodes an encoded file name back to the original package name.
 * @param {string} encoded - The encoded file name, e.g., "_mf_0_scope_mf_1_xx_mf_2_xx_mf_3_xx".
 * @returns {string} - The decoded package name.
 */
function packageNameDecode(encoded) {
  if (typeof encoded !== "string") throw new Error("A string encoded file name is required");
  return encoded.replace(/_mf_0_/g, "@").replace(/_mf_1_/g, "/").replace(/_mf_2_/g, "-").replace(/_mf_3_/g, ".");
}

/**
 * https://github.com/module-federation/vite/issues/68
 */
function getLocalSharedImportMapPath_windows() {
  const {
    name
  } = getNormalizeModuleFederationOptions();
  return path__default.resolve(".__mf__win", packageNameEncode(name), "localSharedImportMap");
}
function writeLocalSharedImportMap_windows(content) {
  const localSharedImportMapId = getLocalSharedImportMapPath_windows();
  createFile(localSharedImportMapId + ".js", "\n// Windows temporarily needs this file, https://github.com/module-federation/vite/issues/68\n" + content);
}
function createFile(filePath, content) {
  const dir = path__default.dirname(filePath);
  mkdirSync(dir, {
    recursive: true
  });
  writeFileSync(filePath, content);
}

const nodeModulesDir = function findNodeModulesDir(startDir = process.cwd()) {
  let currentDir = startDir;
  while (currentDir !== parse(currentDir).root) {
    const nodeModulesPath = join(currentDir, 'node_modules');
    if (existsSync(nodeModulesPath)) {
      return nodeModulesPath;
    }
    currentDir = dirname(currentDir);
  }
  return "";
}();
const virtualPackageName = "__mf__virtual";
if (!existsSync(resolve(nodeModulesDir, virtualPackageName))) {
  mkdirSync(resolve(nodeModulesDir, virtualPackageName));
}
writeFileSync(resolve(nodeModulesDir, virtualPackageName, "empty.js"), "");
writeFileSync(resolve(nodeModulesDir, virtualPackageName, "package.json"), JSON.stringify({
  name: virtualPackageName,
  main: "empty.js"
}));
const patternMap = {};
const cacheMap = {};
/**
 * Physically generate files as virtual modules under node_modules/__mf__virtual/*
 */
class VirtualModule {
  static findModule(tag, str = "") {
    if (!patternMap[tag]) patternMap[tag] = new RegExp(`(.*${packageNameEncode(tag)}(.+?)${packageNameEncode(tag)}.*)`);
    const moduleName = (str.match(patternMap[tag]) || [])[2];
    if (moduleName) return cacheMap[tag][packageNameDecode(moduleName)];
    return undefined;
  }
  constructor(name, tag = '__mf_v__', suffix = "") {
    var _name$split$slice$pop;
    this.name = void 0;
    this.tag = void 0;
    this.suffix = void 0;
    this.inited = false;
    this.name = name;
    this.tag = tag;
    this.suffix = suffix || ((_name$split$slice$pop = name.split(".").slice(1).pop()) == null ? void 0 : _name$split$slice$pop.replace(/(.)/, ".$1")) || ".js";
    if (!cacheMap[this.tag]) cacheMap[this.tag] = {};
    cacheMap[this.tag][this.name] = this;
  }
  getPath() {
    return resolve(nodeModulesDir, this.getImportId());
  }
  getImportId() {
    const {
      name: mfName
    } = getNormalizeModuleFederationOptions();
    return `${virtualPackageName}/${packageNameEncode(`${mfName}${this.tag}${this.name}${this.tag}`)}${this.suffix}`;
  }
  writeSync(code, force) {
    if (!force && this.inited) return;
    if (!this.inited) {
      this.inited = true;
    }
    writeFileSync(this.getPath(), code);
  }
  write(code) {
    writeFile(this.getPath(), code, function () {});
  }
}

const virtualRuntimeInitStatus = new VirtualModule("runtimeInit");
function writeRuntimeInitStatus() {
  virtualRuntimeInitStatus.writeSync(`
    let initResolve, initReject
    const initPromise = new Promise((re, rj) => {
      initResolve = re
      initReject = rj
    })
    export {
      initPromise,
      initResolve,
      initReject
    }
    `);
}

const cacheRemoteMap = {};
const LOAD_REMOTE_TAG = '__loadRemote__';
function getRemoteVirtualModule(remote, command) {
  if (!cacheRemoteMap[remote]) {
    cacheRemoteMap[remote] = new VirtualModule(remote, LOAD_REMOTE_TAG, ".js");
    cacheRemoteMap[remote].writeSync(generateRemotes(remote, command));
  }
  const virtual = cacheRemoteMap[remote];
  return virtual;
}
const usedRemotesMap = {
  // remote1: {remote1/App, remote1, remote1/Button}
};
function addUsedRemote(remoteKey, remoteModule) {
  if (!usedRemotesMap[remoteKey]) usedRemotesMap[remoteKey] = new Set();
  usedRemotesMap[remoteKey].add(remoteModule);
}
function getUsedRemotesMap() {
  return usedRemotesMap;
}
function generateRemotes(id, command) {
  return `
    const {loadRemote} = require("@module-federation/runtime")
    const {initPromise} = require("${virtualRuntimeInitStatus.getImportId()}")
    const res = initPromise.then(_ => loadRemote(${JSON.stringify(id)}))
    const exportModule = ${command !== "build" ? "/*mf top-level-await placeholder replacement mf*/" : "await "}initPromise.then(_ => res)
    module.exports = exportModule
  `;
}

/**
 * Even the resolveId hook cannot interfere with vite pre-build,
 * and adding query parameter virtual modules will also fail.
 * You can only proxy to the real file through alias
 */
// *** __prebuild__
const preBuildCacheMap = {};
const PREBUILD_TAG = "__prebuild__";
function writePreBuildLibPath(pkg) {
  if (!preBuildCacheMap[pkg]) preBuildCacheMap[pkg] = new VirtualModule(pkg, PREBUILD_TAG);
  preBuildCacheMap[pkg].writeSync("");
}
function getPreBuildLibImportId(pkg) {
  if (!preBuildCacheMap[pkg]) preBuildCacheMap[pkg] = new VirtualModule(pkg, PREBUILD_TAG);
  const importId = preBuildCacheMap[pkg].getImportId();
  return importId;
}
// *** __loadShare__
const LOAD_SHARE_TAG = "__loadShare__";
const loadShareCacheMap = {};
function getLoadShareModulePath(pkg) {
  if (!loadShareCacheMap[pkg]) loadShareCacheMap[pkg] = new VirtualModule(pkg, LOAD_SHARE_TAG, ".js");
  const filepath = loadShareCacheMap[pkg].getPath();
  return filepath;
}
function writeLoadShareModule(pkg, shareItem, command) {
  loadShareCacheMap[pkg].writeSync(`
    
    ;() => import(${JSON.stringify(getPreBuildLibImportId(pkg))}).catch(() => {});
    // dev uses dynamic import to separate chunks
    ${command !== "build" ? `;() => import(${JSON.stringify(pkg)}).catch(() => {});` : ''}
    const {loadShare} = require("@module-federation/runtime")
    const {initPromise} = require("${virtualRuntimeInitStatus.getImportId()}")
    const res = initPromise.then(_ => loadShare(${JSON.stringify(pkg)}, {
    customShareInfo: {shareConfig:{
      singleton: ${shareItem.shareConfig.singleton},
      strictVersion: ${shareItem.shareConfig.strictVersion},
      requiredVersion: ${JSON.stringify(shareItem.shareConfig.requiredVersion)}
    }}}))
    const exportModule = ${command !== "build" ? "/*mf top-level-await placeholder replacement mf*/" : "await "}res.then(factory => factory())
    module.exports = exportModule
  `);
}

let usedShares = new Set();
function getUsedShares() {
  return usedShares;
}
function addUsedShares(pkg) {
  usedShares.add(pkg);
}
// *** Expose locally provided shared modules here
const localSharedImportMapModule = new VirtualModule("localSharedImportMap");
function getLocalSharedImportMapPath() {
  if (process.platform === "win32") {
    return getLocalSharedImportMapPath_windows();
  }
  return localSharedImportMapModule.getPath();
}
let prevSharedCount;
function writeLocalSharedImportMap() {
  const sharedCount = getUsedShares().size;
  if (prevSharedCount !== sharedCount) {
    prevSharedCount = sharedCount;
    if (process.platform === "win32") {
      writeLocalSharedImportMap_windows(generateLocalSharedImportMap());
    } else {
      localSharedImportMapModule.writeSync(generateLocalSharedImportMap(), true);
    }
  }
}
function generateLocalSharedImportMap() {
  const options = getNormalizeModuleFederationOptions();
  return `
    const importMap = {
      ${Array.from(getUsedShares()).map(pkg => `
        ${JSON.stringify(pkg)}: async () => {
          let pkg = await import("${getPreBuildLibImportId(pkg)}")
          return pkg
        }
      `).join(",")}
    }
      const usedShared = {
      ${Array.from(getUsedShares()).map(key => {
    const shareItem = getNormalizeShareItem(key);
    return `
          ${JSON.stringify(key)}: {
            name: ${JSON.stringify(key)},
            version: ${JSON.stringify(shareItem.version)},
            scope: [${JSON.stringify(shareItem.scope)}],
            loaded: false,
            from: ${JSON.stringify(options.name)},
            async get () {
              usedShared[${JSON.stringify(key)}].loaded = true
              const {${JSON.stringify(key)}: pkgDynamicImport} = importMap 
              const res = await pkgDynamicImport()
              const exportModule = {...res}
              // All npm packages pre-built by vite will be converted to esm
              Object.defineProperty(exportModule, "__esModule", {
                value: true,
                enumerable: false
              })
              return function () {
                return exportModule
              }
            },
            shareConfig: {
              singleton: ${shareItem.shareConfig.singleton},
              requiredVersion: ${JSON.stringify(shareItem.shareConfig.requiredVersion)}
            }
          }
        `;
  }).join(',')}
    }
      const usedRemotes = [${Object.keys(getUsedRemotesMap()).map(key => {
    const remote = options.remotes[key];
    return `
                {
                  entryGlobalName: ${JSON.stringify(remote.entryGlobalName)},
                  name: ${JSON.stringify(remote.name)},
                  type: ${JSON.stringify(remote.type)},
                  entry: ${JSON.stringify(remote.entry)},
                }
          `;
  }).join(',')}
      ]
      export {
        usedShared,
        usedRemotes
      }
      `;
}
const REMOTE_ENTRY_ID = 'virtual:mf-REMOTE_ENTRY_ID';
function generateRemoteEntry(options) {
  const pluginImportNames = options.runtimePlugins.map((p, i) => [`$runtimePlugin_${i}`, `import $runtimePlugin_${i} from "${p}";`]);
  return `
  import {init as runtimeInit, loadRemote} from "@module-federation/runtime";
  ${pluginImportNames.map(item => item[1]).join('\n')}

  const exposesMap = {
    ${Object.keys(options.exposes).map(key => {
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
  }).join(',')}
  }
  import {usedShared, usedRemotes} from "${getLocalSharedImportMapPath()}"
  import {
    initResolve
  } from "${virtualRuntimeInitStatus.getImportId()}"
  async function init(shared = {}) {
    const initRes = runtimeInit({
      name: ${JSON.stringify(options.name)},
      remotes: usedRemotes,
      shared: usedShared,
      plugins: [${pluginImportNames.map(item => `${item[0]}()`).join(', ')}]
    });
    initRes.initShareScopeMap('${options.shareScope}', shared);
    initResolve(initRes)
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
/**
 * Inject entry file, automatically init when used as host,
 * and will not inject remoteEntry
 */
const hostAutoInitModule = new VirtualModule("hostAutoInit");
function writeHostAutoInit() {
  hostAutoInitModule.writeSync(`
    import {init} from "${REMOTE_ENTRY_ID}"
    init()
    `);
}
function getHostAutoInitImportId() {
  return hostAutoInitModule.getImportId();
}
function getHostAutoInitPath() {
  return hostAutoInitModule.getPath();
}

function initVirtualModules() {
  writeLocalSharedImportMap();
  writeHostAutoInit();
  writeRuntimeInitStatus();
}

const Manifest = () => {
  const mfOptions = getNormalizeModuleFederationOptions();
  const {
    name,
    filename,
    manifest: manifestOptions
  } = mfOptions;
  let mfManifestName = "";
  if (manifestOptions === true) {
    mfManifestName = "mf-manifest.json";
  }
  if (typeof manifestOptions !== "boolean") {
    mfManifestName = join((manifestOptions == null ? void 0 : manifestOptions.filePath) || "", (manifestOptions == null ? void 0 : manifestOptions.fileName) || "");
  }
  let extensions;
  let root;
  let remoteEntryFile;
  return [{
    name: 'moddule-federation-manifest',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!mfManifestName) {
          next();
          return;
        }
        if (req.url === mfManifestName.replace(/^\/?/, "/")) {
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(JSON.stringify({
            id: name,
            name: name,
            metaData: {
              name: name,
              type: 'app',
              buildInfo: {
                buildVersion: '1.0.0',
                buildName: name
              },
              remoteEntry: {
                name: filename,
                path: '',
                type: 'module'
              },
              ssrRemoteEntry: {
                name: filename,
                path: '',
                type: 'module'
              },
              types: {
                path: '',
                name: ''
              },
              globalName: name,
              pluginVersion: '0.2.5',
              publicPath: 'auto'
            },
            shared: Array.from(getUsedShares()).map(shareKey => {
              const shareItem = getNormalizeShareItem(shareKey);
              return {
                id: `${name}:${shareKey}`,
                name: shareKey,
                version: shareItem.version,
                requiredVersion: shareItem.shareConfig.requiredVersion,
                assets: {
                  js: {
                    async: [],
                    sync: []
                  },
                  css: {
                    async: [],
                    sync: []
                  }
                }
              };
            }),
            remotes: function () {
              const remotes = [];
              const usedRemotesMap = getUsedRemotesMap();
              Object.keys(usedRemotesMap).forEach(remoteKey => {
                const usedModules = Array.from(usedRemotesMap[remoteKey]);
                usedModules.forEach(moduleKey => {
                  remotes.push({
                    federationContainerName: mfOptions.remotes[remoteKey].entry,
                    moduleName: moduleKey.replace(remoteKey, '').replace('/', ''),
                    alias: remoteKey,
                    entry: '*'
                  });
                });
              });
              return remotes;
            }(),
            exposes: Object.keys(mfOptions.exposes).map(key => {
              const formatKey = key.replace('./', '');
              return {
                id: name + ':' + formatKey,
                name: formatKey,
                assets: {
                  js: {
                    async: [],
                    sync: []
                  },
                  css: {
                    sync: [],
                    async: []
                  }
                },
                path: key
              };
            })
          }));
        } else {
          next();
        }
      });
    }
  }, {
    name: 'moddule-federation-manifest',
    enforce: 'post',
    config(config) {
      if (!config.build) config.build = {};
      if (!config.build.manifest) config.build.manifest = config.build.manifest || !!manifestOptions;
    },
    configResolved(config) {
      root = config.root;
      extensions = config.resolve.extensions || ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'];
    },
    async generateBundle(options, bundle) {
      if (!mfManifestName) return;
      const exposesModules = Object.keys(mfOptions.exposes).map(item => mfOptions.exposes[item].import); // 获取你提供的 moduleIds
      const filesContainingModules = {};
      // 帮助函数：检查模块路径是否匹配
      const isModuleMatched = (relativeModulePath, preloadModule) => {
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
        if (mfOptions.filename.replace(/[\[\]]/g, "_") === fileData.name) {
          remoteEntryFile = fileData.fileName;
        }
        if (fileData.type === 'chunk') {
          // 遍历该文件的所有模块
          for (const modulePath of Object.keys(fileData.modules)) {
            // 将绝对路径转换为相对于 Vite root 的相对路径
            const relativeModulePath = relative(root, modulePath);
            // 检查模块是否在 preloadModules 列表中
            for (const preloadModule of exposesModules) {
              const formatPreloadModule = preloadModule.replace("./", "");
              if (isModuleMatched(relativeModulePath, formatPreloadModule)) {
                if (!filesContainingModules[preloadModule]) {
                  filesContainingModules[preloadModule] = {
                    sync: [],
                    async: []
                  };
                }
                console.log(Object.keys(fileData.modules));
                filesContainingModules[preloadModule].sync.push(fileName);
                filesContainingModules[preloadModule].async.push(...(fileData.dynamicImports || []));
                findSynchronousImports(fileName, filesContainingModules[preloadModule].sync);
                break; // 如果找到匹配，跳出循环
              }
            }
          }
        }
      }
      // 递归查找模块的同步导入文件
      function findSynchronousImports(fileName, array) {
        const fileData = bundle[fileName];
        if (fileData && fileData.type === 'chunk') {
          array.push(fileName); // 将当前文件加入预加载列表
          // 遍历该文件的同步导入文件
          fileData.imports.forEach(importedFile => {
            if (array.indexOf(importedFile) === -1) {
              findSynchronousImports(importedFile, array); // 递归查找同步导入的文件
            }
          });
        }
      }
      const fileToShareKey = {};
      await Promise.all(Array.from(getUsedShares()).map(async shareKey => {
        const file = (await this.resolve(getPreBuildLibImportId(shareKey))).id.split("?")[0];
        fileToShareKey[file] = shareKey;
      }));
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
                  async: []
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
      Object.keys(filesContainingModules).forEach(key => {
        filesContainingModules[key].sync = Array.from(new Set(filesContainingModules[key].sync));
        filesContainingModules[key].async = Array.from(new Set(filesContainingModules[key].async));
      });
      this.emitFile({
        type: 'asset',
        fileName: mfManifestName,
        source: generateMFManifest(filesContainingModules)
      });
    }
  }];
  function generateMFManifest(preloadMap) {
    const options = getNormalizeModuleFederationOptions();
    const {
      name
    } = options;
    const remoteEntry = {
      name: remoteEntryFile,
      path: '',
      type: 'module'
    };
    const remotes = [];
    const usedRemotesMap = getUsedRemotesMap();
    Object.keys(usedRemotesMap).forEach(remoteKey => {
      const usedModules = Array.from(usedRemotesMap[remoteKey]);
      usedModules.forEach(moduleKey => {
        remotes.push({
          federationContainerName: options.remotes[remoteKey].entry,
          moduleName: moduleKey.replace(remoteKey, '').replace('/', ''),
          alias: remoteKey,
          entry: '*'
        });
      });
    });
    // @ts-ignore
    const shared = Array.from(getUsedShares()).map(shareKey => {
      // assets(.css, .jpg, .svg等)其他资源, 不重要, 暂未处理
      if (!preloadMap[shareKey]) return;
      const shareItem = getNormalizeShareItem(shareKey);
      return {
        id: `${name}:${shareKey}`,
        name: shareKey,
        version: shareItem.version,
        requiredVersion: shareItem.shareConfig.requiredVersion,
        assets: {
          js: {
            async: preloadMap[shareKey].async,
            sync: preloadMap[shareKey].sync
          },
          css: {
            async: [],
            sync: []
          }
        }
      };
    }).filter(item => item);
    const exposes = Object.keys(options.exposes).map(key => {
      // assets(.css, .jpg, .svg等)其他资源, 不重要, 暂未处理
      const formatKey = key.replace('./', '');
      const sourceFile = options.exposes[key].import;
      if (!preloadMap[sourceFile]) return;
      return {
        id: name + ':' + formatKey,
        name: formatKey,
        assets: {
          js: {
            async: preloadMap[sourceFile].async,
            sync: preloadMap[sourceFile].sync
          },
          css: {
            sync: [],
            async: []
          }
        },
        path: key
      };
    }).filter(item => item); // Filter out any null values
    const result = {
      id: name,
      name: name,
      metaData: {
        name: name,
        type: 'app',
        buildInfo: {
          buildVersion: '1.0.0',
          buildName: name
        },
        remoteEntry,
        ssrRemoteEntry: remoteEntry,
        types: {
          path: '',
          name: ''
          // "zip": "@mf-types.zip",
          // "api": "@mf-types.d.ts"
        },
        globalName: name,
        pluginVersion: '0.2.5',
        publicPath: 'auto'
      },
      shared,
      remotes,
      exposes
    };
    return JSON.stringify(result);
  }
};

let _resolve,
  promise = new Promise((resolve, reject) => {
    _resolve = resolve;
  });
let parsePromise = promise;
const parseStartSet = new Set();
const parseEndSet = new Set();
function pluginModuleParseEnd (excludeFn) {
  return [{
    name: "_",
    apply: "serve",
    config() {
      // No waiting in development mode
      _resolve(1);
    }
  }, {
    enforce: "pre",
    name: "parseStart",
    apply: "build",
    load(id) {
      if (excludeFn(id)) {
        return;
      }
      parseStartSet.add(id);
    }
  }, {
    enforce: "post",
    name: "parseEnd",
    apply: "build",
    moduleParsed(module) {
      const id = module.id;
      if (excludeFn(id)) {
        return;
      }
      parseEndSet.add(id);
      if (parseStartSet.size === parseEndSet.size) {
        _resolve(1);
      }
    }
  }];
}

const filter = createFilter();
function pluginProxyRemoteEntry () {
  return {
    name: 'proxyRemoteEntry',
    enforce: 'post',
    resolveId(id) {
      if (id === REMOTE_ENTRY_ID) {
        return REMOTE_ENTRY_ID;
      }
    },
    load(id) {
      if (id === REMOTE_ENTRY_ID) {
        return parsePromise.then(_ => generateRemoteEntry(getNormalizeModuleFederationOptions()));
      }
    },
    async transform(code, id) {
      if (!filter(id)) return;
      if (id.includes(REMOTE_ENTRY_ID)) {
        return parsePromise.then(_ => generateRemoteEntry(getNormalizeModuleFederationOptions()));
      }
    }
  };
}

createFilter();
function pluginProxyRemotes (options) {
  const {
    remotes
  } = options;
  return {
    name: "proxyRemotes",
    config(config, {
      command: _command
    }) {
      Object.keys(remotes).forEach(key => {
        const remote = remotes[key];
        config.resolve.alias.push({
          find: new RegExp(`^(${remote.name}(\/.*|$))`),
          replacement: "$1",
          customResolver(source) {
            const remoteModule = getRemoteVirtualModule(source, _command);
            addUsedRemote(remote.name, source);
            return remoteModule.getPath();
          }
        });
      });
    }
  };
}

/**
 * example:
 * const store = new PromiseStore<number>();
 * store.get("example").then((result) => {
 *  console.log("Result from example:", result); // 42
 * });
 * setTimeout(() => {
 *  store.set("example", Promise.resolve(42));
 * }, 2000);
 */
class PromiseStore {
  constructor() {
    this.promiseMap = new Map();
    this.resolveMap = new Map();
  }
  set(id, promise) {
    if (this.resolveMap.has(id)) {
      promise.then(this.resolveMap.get(id));
      this.resolveMap.delete(id);
    }
    this.promiseMap.set(id, promise);
  }
  get(id) {
    if (this.promiseMap.has(id)) {
      return this.promiseMap.get(id);
    }
    const pendingPromise = new Promise(resolve => {
      this.resolveMap.set(id, resolve);
    });
    this.promiseMap.set(id, pendingPromise);
    return pendingPromise;
  }
}

function proxySharedModule(options) {
  let {
    shared = {},
    include,
    exclude
  } = options;
  return [{
    name: "generateLocalSharedImportMap",
    enforce: "post",
    load(id) {
      if (id.includes(getLocalSharedImportMapPath())) {
        return parsePromise.then(_ => generateLocalSharedImportMap());
      }
    },
    transform(code, id) {
      if (id.includes(getLocalSharedImportMapPath())) {
        return parsePromise.then(_ => generateLocalSharedImportMap());
      }
    }
  }, {
    name: 'proxyPreBuildShared',
    enforce: 'post',
    config(config, {
      command
    }) {
      config.resolve.alias.push(...Object.keys(shared).map(key => {
        const pattern = key.endsWith("/") ? `(^${key.replace(/\/$/, "")}(\/.+)?$)` : `(^${key}$)`;
        return {
          // Intercept all shared requests and proxy them to loadShare
          find: new RegExp(pattern),
          replacement: "$1",
          customResolver(source, importer) {
            const loadSharePath = getLoadShareModulePath(source);
            writeLoadShareModule(source, shared[key], command);
            writePreBuildLibPath(source);
            addUsedShares(source);
            writeLocalSharedImportMap();
            return this.resolve(loadSharePath);
          }
        };
      }));
      const savePrebuild = new PromiseStore();
      config.resolve.alias.push(...Object.keys(shared).map(key => {
        return command === "build" ? {
          find: new RegExp(`(.*${PREBUILD_TAG}.*)`),
          replacement: function ($1) {
            const pkgName = VirtualModule.findModule(PREBUILD_TAG, $1).name;
            return pkgName;
          }
        } : {
          find: new RegExp(`(.*${PREBUILD_TAG}.*)`),
          replacement: "$1",
          async customResolver(source, importer) {
            const pkgName = VirtualModule.findModule(PREBUILD_TAG, source).name;
            if (importer.includes(LOAD_SHARE_TAG)) {
              // save pre-bunding module id
              savePrebuild.set(pkgName, this.resolve(pkgName).then(item => item.id));
            }
            // Fix localSharedImportMap import id
            return await this.resolve(await savePrebuild.get(pkgName));
          }
        };
      }));
    }
  }, {
    name: "watchLocalSharedImportMap",
    apply: "serve",
    config(config) {
      config.optimizeDeps = defu(config.optimizeDeps, {
        exclude: [getLocalSharedImportMapPath()]
      });
      config.server = defu(config.server, {
        watch: {
          ignored: []
        }
      });
      const watch = config.server.watch;
      watch.ignored = [].concat(watch.ignored);
      watch.ignored.push(`!**${getLocalSharedImportMapPath()}**`);
    }
  }];
}

var aliasToArrayPlugin = {
  name: 'alias-transform-plugin',
  config: (config, {
    command
  }) => {
    if (!config.resolve) config.resolve = {};
    if (!config.resolve.alias) config.resolve.alias = [];
    const {
      alias
    } = config.resolve;
    if (typeof alias === 'object' && !Array.isArray(alias)) {
      config.resolve.alias = Object.entries(alias).map(([find, replacement]) => ({
        find,
        replacement
      }));
    }
  }
};

var normalizeOptimizeDepsPlugin = {
  name: 'normalizeOptimizeDeps',
  config: (config, {
    command
  }) => {
    let {
      optimizeDeps
    } = config;
    if (!optimizeDeps) {
      config.optimizeDeps = {};
      optimizeDeps = config.optimizeDeps;
    }
    // todo: fix this workaround
    optimizeDeps.force = true;
    if (!optimizeDeps.include) optimizeDeps.include = [];
    if (!optimizeDeps.needsInterop) optimizeDeps.needsInterop = [];
  }
};

function federation(mfUserOptions) {
  const options = normalizeModuleFederationOptions(mfUserOptions);
  initVirtualModules();
  const {
    name,
    remotes,
    shared,
    filename
  } = options;
  if (!name) throw new Error("name is required");
  return [aliasToArrayPlugin, normalizeOptimizeDepsPlugin, ...addEntry({
    entryName: 'remoteEntry',
    entryPath: REMOTE_ENTRY_ID,
    fileName: filename
  }), ...addEntry({
    entryName: 'hostInit',
    entryPath: getHostAutoInitPath()
  }), pluginProxyRemoteEntry(), pluginProxyRemotes(options), ...pluginModuleParseEnd(id => {
    return id.includes(getHostAutoInitImportId()) || id.includes(REMOTE_ENTRY_ID) || id.includes(getLocalSharedImportMapPath());
  }), ...proxySharedModule({
    shared
  }), PluginDevProxyModuleTopLevelAwait(), {
    name: 'module-federation-vite',
    enforce: 'post',
    config(config, {
      command: _command
    }) {
      var _config$optimizeDeps;
      config.resolve.alias.push({
        find: '@module-federation/runtime',
        replacement: require.resolve('@module-federation/runtime')
      });
      (_config$optimizeDeps = config.optimizeDeps) == null || (_config$optimizeDeps = _config$optimizeDeps.include) == null || _config$optimizeDeps.push('@module-federation/runtime');
    }
  }, ...Manifest()];
}

export { federation };

import * as fs from 'fs';
import { mkdirSync, writeFileSync, existsSync, writeFile } from 'fs';
import * as path from 'pathe';
import path__default, { parse, join, dirname, resolve, relative } from 'pathe';
import { createFilter } from '@rollup/pluginutils';
import { walk } from 'estree-walker';
import MagicString from 'magic-string';
import { defu } from 'defu';

var addEntry = function addEntry(_ref) {
  var entryName = _ref.entryName,
    entryPath = _ref.entryPath,
    fileName = _ref.fileName;
  var devEntryPath = entryPath.startsWith("virtual:mf") ? "/@id/" + entryPath : entryPath;
  var entryFiles = [];
  var htmlFilePath;
  var _command;
  return [{
    name: 'add-entry',
    apply: "serve",
    config: function config(_config, _ref2) {
      var command = _ref2.command;
      _command = command;
    },
    configureServer: function configureServer(server) {
      var _server$httpServer;
      (_server$httpServer = server.httpServer) == null || _server$httpServer.once == null || _server$httpServer.once('listening', function () {
        var port = server.config.server.port;
        fetch(path.join("http://localhost:" + port, "" + devEntryPath))["catch"](function (e) {});
      });
      server.middlewares.use(function (req, res, next) {
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
    transformIndexHtml: function transformIndexHtml(c) {
      return c.replace('<head>', "<head><script type=\"module\" src=" + JSON.stringify(devEntryPath.replace(/.+?\:([/\\])[/\\]?/, '$1').replace(/\\\\?/g, '/')) + "></script>");
    }
  }, {
    name: "add-entry",
    enforce: "post",
    configResolved: function configResolved(config) {
      var inputOptions = config.build.rollupOptions.input;
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
    buildStart: function buildStart() {
      var _this$emitFile;
      if (_command === "serve") return;
      var hasHash = fileName == null || fileName.includes == null ? void 0 : fileName.includes("[hash");
      this.emitFile((_this$emitFile = {
        name: entryName
      }, _this$emitFile[hasHash ? "name" : "fileName"] = fileName, _this$emitFile.type = 'chunk', _this$emitFile.id = entryPath, _this$emitFile.preserveSignature = 'strict', _this$emitFile));
      if (htmlFilePath) {
        var htmlContent = fs.readFileSync(htmlFilePath, 'utf-8');
        var scriptRegex = /<script\s+[^>]*src=["']([^"']+)["'][^>]*>/gi;
        var match;
        while ((match = scriptRegex.exec(htmlContent)) !== null) {
          entryFiles.push(match[1]);
        }
      }
    },
    transform: function transform(code, id) {
      if (entryFiles.some(function (file) {
        return id.endsWith(file);
      })) {
        var injection = "\n          import " + JSON.stringify(entryPath) + ";\n          ";
        return injection + code;
      }
    }
  }];
};

/**
 * Solve the problem that dev mode dependency prebunding does not support top-level await syntax
 */
function PluginDevProxyModuleTopLevelAwait() {
  var filterFunction = createFilter();
  return {
    name: "dev-proxy-module-top-level-await",
    apply: "serve",
    transform: function transform(code, id) {
      if (!code.includes("/*mf top-level-await placeholder replacement mf*/")) {
        return null;
      }
      if (!filterFunction(id)) return null;
      var ast;
      try {
        ast = this.parse(code, {
          allowReturnOutsideFunction: true
        });
      } catch (e) {
        throw new Error(id + ": " + e);
      }
      var magicString = new MagicString(code);
      walk(ast, {
        enter: function enter(node) {
          if (node.type === 'ExportNamedDeclaration' && node.specifiers) {
            var exportSpecifiers = node.specifiers.map(function (specifier) {
              return specifier.exported.name;
            });
            var proxyStatements = exportSpecifiers.map(function (name) {
              return "\n              const __mfproxy__await" + name + " = await " + name + "();\n              const __mfproxy__" + name + " = () => __mfproxy__await" + name + ";\n            ";
            }).join('\n');
            var exportStatements = exportSpecifiers.map(function (name) {
              return "__mfproxy__" + name + " as " + name;
            }).join(', ');
            var start = node.start;
            var end = node.end;
            var replacement = proxyStatements + "\nexport { " + exportStatements + " };";
            magicString.overwrite(start, end, replacement);
          }
          if (node.type === 'ExportDefaultDeclaration') {
            var declaration = node.declaration;
            var _start = node.start;
            var _end = node.end;
            var proxyStatement;
            var exportStatement = 'default';
            if (declaration.type === 'Identifier') {
              // example: export default foo;
              proxyStatement = "\n                const __mfproxy__awaitdefault = await " + declaration.name + "();\n                const __mfproxy__default = __mfproxy__awaitdefault;\n              ";
            } else if (declaration.type === 'CallExpression' || declaration.type === 'FunctionDeclaration') {
              // example: export default someFunction();
              var declarationCode = code.slice(declaration.start, declaration.end);
              proxyStatement = "\n                const __mfproxy__awaitdefault = await (" + declarationCode + ");\n                const __mfproxy__default = __mfproxy__awaitdefault;\n              ";
            } else {
              // other
              proxyStatement = "\n                const __mfproxy__awaitdefault = await (" + code.slice(declaration.start, declaration.end) + ");\n                const __mfproxy__default = __mfproxy__awaitdefault;\n              ";
            }
            var _replacement = proxyStatement + "\nexport { __mfproxy__default as " + exportStatement + " };";
            magicString.overwrite(_start, _end, _replacement);
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

function _arrayLikeToArray(r, a) {
  (null == a || a > r.length) && (a = r.length);
  for (var e = 0, n = Array(a); e < a; e++) n[e] = r[e];
  return n;
}
function _createForOfIteratorHelperLoose(r, e) {
  var t = "undefined" != typeof Symbol && r[Symbol.iterator] || r["@@iterator"];
  if (t) return (t = t.call(r)).next.bind(t);
  if (Array.isArray(r) || (t = _unsupportedIterableToArray(r)) || e && r && "number" == typeof r.length) {
    t && (r = t);
    var o = 0;
    return function () {
      return o >= r.length ? {
        done: !0
      } : {
        done: !1,
        value: r[o++]
      };
    };
  }
  throw new TypeError("Invalid attempt to iterate non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
}
function _unsupportedIterableToArray(r, a) {
  if (r) {
    if ("string" == typeof r) return _arrayLikeToArray(r, a);
    var t = {}.toString.call(r).slice(8, -1);
    return "Object" === t && r.constructor && (t = r.constructor.name), "Map" === t || "Set" === t ? Array.from(r) : "Arguments" === t || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(t) ? _arrayLikeToArray(r, a) : void 0;
  }
}

function normalizeExposesItem(key, item) {
  var importPath = '';
  if (typeof item === 'string') {
    importPath = item;
  }
  if (typeof item === 'object') {
    importPath = item["import"];
  }
  return {
    "import": importPath
  };
}
function normalizeExposes(exposes) {
  if (!exposes) return {};
  var res = {};
  Object.keys(exposes).forEach(function (key) {
    res[key] = normalizeExposesItem(key, exposes[key]);
  });
  return res;
}
function normalizeRemotes(remotes) {
  if (!remotes) return {};
  var result = {};
  if (typeof remotes === 'object') {
    Object.keys(remotes).forEach(function (key) {
      result[key] = normalizeRemoteItem(key, remotes[key]);
    });
  }
  return result;
}
function normalizeRemoteItem(key, remote) {
  if (typeof remote === 'string') {
    var _remote$split = remote.split('@'),
      entryGlobalName = _remote$split[0];
    var entry = remote.replace(entryGlobalName + '@', '');
    return {
      type: 'var',
      name: key,
      entry: entry,
      entryGlobalName: entryGlobalName,
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
  var regex = /^(?:@[^/]+\/)?[^/]+/;
  // 使用正则表达式匹配并提取包名
  var match = packageString.match(regex);
  // 返回匹配到的包名，如果没有匹配到则返回原字符串
  return match ? match[0] : packageString;
}
function normalizeShareItem(key, shareItem) {
  var version;
  try {
    version = require(path.join(removePathFromNpmPackage(key), 'package.json')).version;
  } catch (e) {
    console.log(e);
  }
  if (typeof shareItem === 'string') {
    return {
      name: shareItem,
      version: version,
      scope: 'default',
      from: '',
      shareConfig: {
        singleton: false,
        requiredVersion: "^" + version || '*'
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
      requiredVersion: shareItem.requiredVersion || "^" + version || '*',
      strictVersion: !!shareItem.strictVersion
    }
  };
}
function normalizeShared(shared) {
  if (!shared) return {};
  var result = {};
  if (Array.isArray(shared)) {
    shared.forEach(function (key) {
      result[key] = normalizeShareItem(key, key);
    });
    return result;
  }
  if (typeof shared === 'object') {
    Object.keys(shared).forEach(function (key) {
      result[key] = normalizeShareItem(key, shared[key]);
    });
  }
  return result;
}
function normalizeLibrary(library) {
  if (!library) return undefined;
  return library;
}
function normalizeManifest(manifest) {
  if (manifest === void 0) {
    manifest = false;
  }
  if (typeof manifest === "boolean") {
    return manifest;
  }
  return Object.assign({
    filePath: "",
    disableAssetsAnalyze: false,
    fileName: "mf-manifest.json"
  }, manifest);
}
var config;
function getNormalizeModuleFederationOptions() {
  return config;
}
function getNormalizeShareItem(key) {
  var options = getNormalizeModuleFederationOptions();
  var shareItem = options.shared[removePathFromNpmPackage(key)] || options.shared[removePathFromNpmPackage(key) + "/"];
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
function getLocalSharedImportMapPath_temp() {
  var _getNormalizeModuleFe = getNormalizeModuleFederationOptions(),
    name = _getNormalizeModuleFe.name;
  return path__default.resolve(".__mf__temp", packageNameEncode(name), "localSharedImportMap");
}
function writeLocalSharedImportMap_temp(content) {
  var localSharedImportMapId = getLocalSharedImportMapPath_temp();
  createFile(localSharedImportMapId + ".js", "\n// Windows temporarily needs this file, https://github.com/module-federation/vite/issues/68\n" + content);
}
function createFile(filePath, content) {
  var dir = path__default.dirname(filePath);
  mkdirSync(dir, {
    recursive: true
  });
  writeFileSync(filePath, content);
}

var nodeModulesDir = function findNodeModulesDir(startDir) {
  if (startDir === void 0) {
    startDir = process.cwd();
  }
  var currentDir = startDir;
  while (currentDir !== parse(currentDir).root) {
    var nodeModulesPath = join(currentDir, 'node_modules');
    if (existsSync(nodeModulesPath)) {
      return nodeModulesPath;
    }
    currentDir = dirname(currentDir);
  }
  return "";
}();
var virtualPackageName = "__mf__virtual";
if (!existsSync(resolve(nodeModulesDir, virtualPackageName))) {
  mkdirSync(resolve(nodeModulesDir, virtualPackageName));
}
writeFileSync(resolve(nodeModulesDir, virtualPackageName, "empty.js"), "");
writeFileSync(resolve(nodeModulesDir, virtualPackageName, "package.json"), JSON.stringify({
  name: virtualPackageName,
  main: "empty.js"
}));
var patternMap = {};
var cacheMap = {};
/**
 * Physically generate files as virtual modules under node_modules/__mf__virtual/*
 */
var VirtualModule = /*#__PURE__*/function () {
  function VirtualModule(name, tag, suffix) {
    var _name$split$slice$pop;
    if (tag === void 0) {
      tag = '__mf_v__';
    }
    if (suffix === void 0) {
      suffix = "";
    }
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
  VirtualModule.findModule = function findModule(tag, str) {
    if (str === void 0) {
      str = "";
    }
    if (!patternMap[tag]) patternMap[tag] = new RegExp("(.*" + packageNameEncode(tag) + "(.+?)" + packageNameEncode(tag) + ".*)");
    var moduleName = (str.match(patternMap[tag]) || [])[2];
    if (moduleName) return cacheMap[tag][packageNameDecode(moduleName)];
    return undefined;
  };
  var _proto = VirtualModule.prototype;
  _proto.getPath = function getPath() {
    return resolve(nodeModulesDir, this.getImportId());
  };
  _proto.getImportId = function getImportId() {
    var _getNormalizeModuleFe = getNormalizeModuleFederationOptions(),
      mfName = _getNormalizeModuleFe.name;
    return virtualPackageName + "/" + packageNameEncode("" + mfName + this.tag + this.name + this.tag) + this.suffix;
  };
  _proto.writeSync = function writeSync(code, force) {
    if (!force && this.inited) return;
    if (!this.inited) {
      this.inited = true;
    }
    writeFileSync(this.getPath(), code);
  };
  _proto.write = function write(code) {
    writeFile(this.getPath(), code, function () {});
  };
  return VirtualModule;
}();

var virtualRuntimeInitStatus = new VirtualModule("runtimeInit");
function writeRuntimeInitStatus() {
  virtualRuntimeInitStatus.writeSync("\n    let initResolve, initReject\n    const initPromise = new Promise((re, rj) => {\n      initResolve = re\n      initReject = rj\n    })\n    export {\n      initPromise,\n      initResolve,\n      initReject\n    }\n    ");
}

var cacheRemoteMap = {};
var LOAD_REMOTE_TAG = '__loadRemote__';
function getRemoteVirtualModule(remote, command) {
  if (!cacheRemoteMap[remote]) {
    cacheRemoteMap[remote] = new VirtualModule(remote, LOAD_REMOTE_TAG, ".js");
    cacheRemoteMap[remote].writeSync(generateRemotes(remote, command));
  }
  var virtual = cacheRemoteMap[remote];
  return virtual;
}
var usedRemotesMap = {
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
  return "\n    const {loadRemote} = require(\"@module-federation/runtime\")\n    const {initPromise} = require(\"" + virtualRuntimeInitStatus.getImportId() + "\")\n    const res = initPromise.then(_ => loadRemote(" + JSON.stringify(id) + "))\n    const exportModule = " + (command !== "build" ? "/*mf top-level-await placeholder replacement mf*/" : "await ") + "initPromise.then(_ => res)\n    module.exports = exportModule\n  ";
}

/**
 * Even the resolveId hook cannot interfere with vite pre-build,
 * and adding query parameter virtual modules will also fail.
 * You can only proxy to the real file through alias
 */
// *** __prebuild__
var preBuildCacheMap = {};
var PREBUILD_TAG = "__prebuild__";
function writePreBuildLibPath(pkg) {
  if (!preBuildCacheMap[pkg]) preBuildCacheMap[pkg] = new VirtualModule(pkg, PREBUILD_TAG);
  preBuildCacheMap[pkg].writeSync("");
}
function getPreBuildLibImportId(pkg) {
  if (!preBuildCacheMap[pkg]) preBuildCacheMap[pkg] = new VirtualModule(pkg, PREBUILD_TAG);
  var importId = preBuildCacheMap[pkg].getImportId();
  return importId;
}
// *** __loadShare__
var LOAD_SHARE_TAG = "__loadShare__";
var loadShareCacheMap = {};
function getLoadShareModulePath(pkg) {
  if (!loadShareCacheMap[pkg]) loadShareCacheMap[pkg] = new VirtualModule(pkg, LOAD_SHARE_TAG, ".js");
  var filepath = loadShareCacheMap[pkg].getPath();
  return filepath;
}
function writeLoadShareModule(pkg, shareItem, command) {
  loadShareCacheMap[pkg].writeSync("\n    \n    ;() => import(" + JSON.stringify(getPreBuildLibImportId(pkg)) + ").catch(() => {});\n    // dev uses dynamic import to separate chunks\n    " + (command !== "build" ? ";() => import(" + JSON.stringify(pkg) + ").catch(() => {});" : '') + "\n    const {loadShare} = require(\"@module-federation/runtime\")\n    const {initPromise} = require(\"" + virtualRuntimeInitStatus.getImportId() + "\")\n    const res = initPromise.then(_ => loadShare(" + JSON.stringify(pkg) + ", {\n    customShareInfo: {shareConfig:{\n      singleton: " + shareItem.shareConfig.singleton + ",\n      strictVersion: " + shareItem.shareConfig.strictVersion + ",\n      requiredVersion: " + JSON.stringify(shareItem.shareConfig.requiredVersion) + "\n    }}}))\n    const exportModule = " + (command !== "build" ? "/*mf top-level-await placeholder replacement mf*/" : "await ") + "res.then(factory => factory())\n    module.exports = exportModule\n  ");
}

var usedShares = new Set();
function getUsedShares() {
  return usedShares;
}
function addUsedShares(pkg) {
  usedShares.add(pkg);
}
// *** Expose locally provided shared modules here
new VirtualModule("localSharedImportMap");
function getLocalSharedImportMapPath() {
  return getLocalSharedImportMapPath_temp();
  // return localSharedImportMapModule.getPath()
}
var prevSharedCount;
function writeLocalSharedImportMap() {
  var sharedCount = getUsedShares().size;
  if (prevSharedCount !== sharedCount) {
    prevSharedCount = sharedCount;
    writeLocalSharedImportMap_temp(generateLocalSharedImportMap());
    //   localSharedImportMapModule.writeSync(generateLocalSharedImportMap(), true)
  }
}
function generateLocalSharedImportMap() {
  var options = getNormalizeModuleFederationOptions();
  return "\n    const importMap = {\n      " + Array.from(getUsedShares()).map(function (pkg) {
    return "\n        " + JSON.stringify(pkg) + ": async () => {\n          let pkg = await import(\"" + getPreBuildLibImportId(pkg) + "\")\n          return pkg\n        }\n      ";
  }).join(",") + "\n    }\n      const usedShared = {\n      " + Array.from(getUsedShares()).map(function (key) {
    var shareItem = getNormalizeShareItem(key);
    return "\n          " + JSON.stringify(key) + ": {\n            name: " + JSON.stringify(key) + ",\n            version: " + JSON.stringify(shareItem.version) + ",\n            scope: [" + JSON.stringify(shareItem.scope) + "],\n            loaded: false,\n            from: " + JSON.stringify(options.name) + ",\n            async get () {\n              usedShared[" + JSON.stringify(key) + "].loaded = true\n              const {" + JSON.stringify(key) + ": pkgDynamicImport} = importMap \n              const res = await pkgDynamicImport()\n              const exportModule = {...res}\n              // All npm packages pre-built by vite will be converted to esm\n              Object.defineProperty(exportModule, \"__esModule\", {\n                value: true,\n                enumerable: false\n              })\n              return function () {\n                return exportModule\n              }\n            },\n            shareConfig: {\n              singleton: " + shareItem.shareConfig.singleton + ",\n              requiredVersion: " + JSON.stringify(shareItem.shareConfig.requiredVersion) + "\n            }\n          }\n        ";
  }).join(',') + "\n    }\n      const usedRemotes = [" + Object.keys(getUsedRemotesMap()).map(function (key) {
    var remote = options.remotes[key];
    return "\n                {\n                  entryGlobalName: " + JSON.stringify(remote.entryGlobalName) + ",\n                  name: " + JSON.stringify(remote.name) + ",\n                  type: " + JSON.stringify(remote.type) + ",\n                  entry: " + JSON.stringify(remote.entry) + ",\n                }\n          ";
  }).join(',') + "\n      ]\n      export {\n        usedShared,\n        usedRemotes\n      }\n      ";
}
var REMOTE_ENTRY_ID = 'virtual:mf-REMOTE_ENTRY_ID';
function generateRemoteEntry(options) {
  var pluginImportNames = options.runtimePlugins.map(function (p, i) {
    return ["$runtimePlugin_" + i, "import $runtimePlugin_" + i + " from \"" + p + "\";"];
  });
  return "\n  import {init as runtimeInit, loadRemote} from \"@module-federation/runtime\";\n  " + pluginImportNames.map(function (item) {
    return item[1];
  }).join('\n') + "\n\n  const exposesMap = {\n    " + Object.keys(options.exposes).map(function (key) {
    return "\n        " + JSON.stringify(key) + ": async () => {\n          const importModule = await import(" + JSON.stringify(options.exposes[key]["import"]) + ")\n          const exportModule = {}\n          Object.assign(exportModule, importModule)\n          Object.defineProperty(exportModule, \"__esModule\", {\n            value: true,\n            enumerable: false\n          })\n          return exportModule\n        }\n      ";
  }).join(',') + "\n  }\n  import {usedShared, usedRemotes} from \"" + getLocalSharedImportMapPath() + "\"\n  import {\n    initResolve\n  } from \"" + virtualRuntimeInitStatus.getImportId() + "\"\n  async function init(shared = {}) {\n    const initRes = runtimeInit({\n      name: " + JSON.stringify(options.name) + ",\n      remotes: usedRemotes,\n      shared: usedShared,\n      plugins: [" + pluginImportNames.map(function (item) {
    return item[0] + "()";
  }).join(', ') + "]\n    });\n    initRes.initShareScopeMap('" + options.shareScope + "', shared);\n    initResolve(initRes)\n    return initRes\n  }\n\n  function getExposes(moduleName) {\n    if (!(moduleName in exposesMap)) throw new Error(`Module ${moduleName} does not exist in container.`)\n    return (exposesMap[moduleName])().then(res => () => res)\n  }\n  export {\n      init,\n      getExposes as get\n  }\n  ";
}
/**
 * Inject entry file, automatically init when used as host,
 * and will not inject remoteEntry
 */
var hostAutoInitModule = new VirtualModule("hostAutoInit");
function writeHostAutoInit() {
  hostAutoInitModule.writeSync("\n    import {init} from \"" + REMOTE_ENTRY_ID + "\"\n    init()\n    ");
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

var Manifest = function Manifest() {
  var mfOptions = getNormalizeModuleFederationOptions();
  var name = mfOptions.name,
    filename = mfOptions.filename,
    manifestOptions = mfOptions.manifest;
  var mfManifestName = "";
  if (manifestOptions === true) {
    mfManifestName = "mf-manifest.json";
  }
  if (typeof manifestOptions !== "boolean") {
    mfManifestName = join((manifestOptions == null ? void 0 : manifestOptions.filePath) || "", (manifestOptions == null ? void 0 : manifestOptions.fileName) || "");
  }
  var extensions;
  var root;
  var remoteEntryFile;
  return [{
    name: 'moddule-federation-manifest',
    apply: 'serve',
    configureServer: function configureServer(server) {
      server.middlewares.use(function (req, res, next) {
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
            shared: Array.from(getUsedShares()).map(function (shareKey) {
              var shareItem = getNormalizeShareItem(shareKey);
              return {
                id: name + ":" + shareKey,
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
              var remotes = [];
              var usedRemotesMap = getUsedRemotesMap();
              Object.keys(usedRemotesMap).forEach(function (remoteKey) {
                var usedModules = Array.from(usedRemotesMap[remoteKey]);
                usedModules.forEach(function (moduleKey) {
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
            exposes: Object.keys(mfOptions.exposes).map(function (key) {
              var formatKey = key.replace('./', '');
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
    config: function config(_config) {
      if (!_config.build) _config.build = {};
      if (!_config.build.manifest) _config.build.manifest = _config.build.manifest || !!manifestOptions;
    },
    configResolved: function configResolved(config) {
      root = config.root;
      extensions = config.resolve.extensions || ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'];
    },
    generateBundle: function generateBundle(options, bundle) {
      try {
        var _this = this;
        // 递归查找模块的同步导入文件
        var _findSynchronousImports = function findSynchronousImports(fileName, array) {
          var fileData = bundle[fileName];
          if (fileData && fileData.type === 'chunk') {
            array.push(fileName); // 将当前文件加入预加载列表
            // 遍历该文件的同步导入文件
            fileData.imports.forEach(function (importedFile) {
              if (array.indexOf(importedFile) === -1) {
                _findSynchronousImports(importedFile, array); // 递归查找同步导入的文件
              }
            });
          }
        };
        if (!mfManifestName) return Promise.resolve();
        var exposesModules = Object.keys(mfOptions.exposes).map(function (item) {
          return mfOptions.exposes[item]["import"];
        }); // 获取你提供的 moduleIds
        var filesContainingModules = {};
        // 帮助函数：检查模块路径是否匹配
        var isModuleMatched = function isModuleMatched(relativeModulePath, preloadModule) {
          // 先尝试直接匹配
          if (relativeModulePath === preloadModule) return true;
          // 如果 preloadModule 没有后缀，尝试添加可能的后缀进行匹配
          for (var _iterator = _createForOfIteratorHelperLoose(extensions), _step; !(_step = _iterator()).done;) {
            var ext = _step.value;
            if (relativeModulePath === "" + preloadModule + ext) {
              return true;
            }
          }
          return false;
        };
        // 遍历打包生成的每个文件
        for (var _i = 0, _Object$entries = Object.entries(bundle); _i < _Object$entries.length; _i++) {
          var _Object$entries$_i = _Object$entries[_i],
            fileName = _Object$entries$_i[0],
            fileData = _Object$entries$_i[1];
          if (mfOptions.filename.replace(/[\[\]]/g, "_") === fileData.name) {
            remoteEntryFile = fileData.fileName;
          }
          if (fileData.type === 'chunk') {
            // 遍历该文件的所有模块
            for (var _i2 = 0, _Object$keys = Object.keys(fileData.modules); _i2 < _Object$keys.length; _i2++) {
              var modulePath = _Object$keys[_i2];
              // 将绝对路径转换为相对于 Vite root 的相对路径
              var relativeModulePath = relative(root, modulePath);
              // 检查模块是否在 preloadModules 列表中
              for (var _iterator2 = _createForOfIteratorHelperLoose(exposesModules), _step2; !(_step2 = _iterator2()).done;) {
                var preloadModule = _step2.value;
                var formatPreloadModule = preloadModule.replace("./", "");
                if (isModuleMatched(relativeModulePath, formatPreloadModule)) {
                  var _filesContainingModul;
                  if (!filesContainingModules[preloadModule]) {
                    filesContainingModules[preloadModule] = {
                      sync: [],
                      async: []
                    };
                  }
                  console.log(Object.keys(fileData.modules));
                  filesContainingModules[preloadModule].sync.push(fileName);
                  (_filesContainingModul = filesContainingModules[preloadModule].async).push.apply(_filesContainingModul, fileData.dynamicImports || []);
                  _findSynchronousImports(fileName, filesContainingModules[preloadModule].sync);
                  break; // 如果找到匹配，跳出循环
                }
              }
            }
          }
        }
        ;
        var fileToShareKey = {};
        return Promise.resolve(Promise.all(Array.from(getUsedShares()).map(function (shareKey) {
          try {
            return Promise.resolve(_this.resolve(getPreBuildLibImportId(shareKey))).then(function (_this$resolve) {
              var file = _this$resolve.id.split("?")[0];
              fileToShareKey[file] = shareKey;
            });
          } catch (e) {
            return Promise.reject(e);
          }
        }))).then(function () {
          // 遍历打包生成的每个文件
          for (var _i3 = 0, _Object$entries2 = Object.entries(bundle); _i3 < _Object$entries2.length; _i3++) {
            var _Object$entries2$_i = _Object$entries2[_i3],
              _fileName = _Object$entries2$_i[0],
              _fileData = _Object$entries2$_i[1];
            if (_fileData.type === 'chunk') {
              // 遍历该文件的所有模块
              for (var _i4 = 0, _Object$keys2 = Object.keys(_fileData.modules); _i4 < _Object$keys2.length; _i4++) {
                var _modulePath = _Object$keys2[_i4];
                var sharedKey = fileToShareKey[_modulePath];
                if (sharedKey) {
                  var _filesContainingModul2;
                  if (!filesContainingModules[sharedKey]) {
                    filesContainingModules[sharedKey] = {
                      sync: [],
                      async: []
                    };
                  }
                  filesContainingModules[sharedKey].sync.push(_fileName);
                  (_filesContainingModul2 = filesContainingModules[sharedKey].async).push.apply(_filesContainingModul2, _fileData.dynamicImports || []);
                  _findSynchronousImports(_fileName, filesContainingModules[sharedKey].sync);
                  break; // 如果找到匹配，跳出循环
                }
              }
            }
          }
          Object.keys(filesContainingModules).forEach(function (key) {
            filesContainingModules[key].sync = Array.from(new Set(filesContainingModules[key].sync));
            filesContainingModules[key].async = Array.from(new Set(filesContainingModules[key].async));
          });
          _this.emitFile({
            type: 'asset',
            fileName: mfManifestName,
            source: generateMFManifest(filesContainingModules)
          });
        });
      } catch (e) {
        return Promise.reject(e);
      }
    }
  }];
  function generateMFManifest(preloadMap) {
    var options = getNormalizeModuleFederationOptions();
    var name = options.name;
    var remoteEntry = {
      name: remoteEntryFile,
      path: '',
      type: 'module'
    };
    var remotes = [];
    var usedRemotesMap = getUsedRemotesMap();
    Object.keys(usedRemotesMap).forEach(function (remoteKey) {
      var usedModules = Array.from(usedRemotesMap[remoteKey]);
      usedModules.forEach(function (moduleKey) {
        remotes.push({
          federationContainerName: options.remotes[remoteKey].entry,
          moduleName: moduleKey.replace(remoteKey, '').replace('/', ''),
          alias: remoteKey,
          entry: '*'
        });
      });
    });
    // @ts-ignore
    var shared = Array.from(getUsedShares()).map(function (shareKey) {
      // assets(.css, .jpg, .svg等)其他资源, 不重要, 暂未处理
      if (!preloadMap[shareKey]) return;
      var shareItem = getNormalizeShareItem(shareKey);
      return {
        id: name + ":" + shareKey,
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
    }).filter(function (item) {
      return item;
    });
    var exposes = Object.keys(options.exposes).map(function (key) {
      // assets(.css, .jpg, .svg等)其他资源, 不重要, 暂未处理
      var formatKey = key.replace('./', '');
      var sourceFile = options.exposes[key]["import"];
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
    }).filter(function (item) {
      return item;
    }); // Filter out any null values
    var result = {
      id: name,
      name: name,
      metaData: {
        name: name,
        type: 'app',
        buildInfo: {
          buildVersion: '1.0.0',
          buildName: name
        },
        remoteEntry: remoteEntry,
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
      shared: shared,
      remotes: remotes,
      exposes: exposes
    };
    return JSON.stringify(result);
  }
};

var _resolve,
  promise = new Promise(function (resolve, reject) {
    _resolve = resolve;
  });
var parsePromise = promise;
var parseStartSet = new Set();
var parseEndSet = new Set();
function pluginModuleParseEnd (excludeFn) {
  return [{
    name: "_",
    apply: "serve",
    config: function config() {
      // No waiting in development mode
      _resolve(1);
    }
  }, {
    enforce: "pre",
    name: "parseStart",
    apply: "build",
    load: function load(id) {
      if (excludeFn(id)) {
        return;
      }
      parseStartSet.add(id);
    }
  }, {
    enforce: "post",
    name: "parseEnd",
    apply: "build",
    moduleParsed: function moduleParsed(module) {
      var id = module.id;
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

var filter = createFilter();
function pluginProxyRemoteEntry () {
  return {
    name: 'proxyRemoteEntry',
    enforce: 'post',
    resolveId: function resolveId(id) {
      if (id === REMOTE_ENTRY_ID) {
        return REMOTE_ENTRY_ID;
      }
    },
    load: function load(id) {
      if (id === REMOTE_ENTRY_ID) {
        return parsePromise.then(function (_) {
          return generateRemoteEntry(getNormalizeModuleFederationOptions());
        });
      }
    },
    transform: function transform(code, id) {
      try {
        if (!filter(id)) return Promise.resolve();
        if (id.includes(REMOTE_ENTRY_ID)) {
          return Promise.resolve(parsePromise.then(function (_) {
            return generateRemoteEntry(getNormalizeModuleFederationOptions());
          }));
        }
        return Promise.resolve();
      } catch (e) {
        return Promise.reject(e);
      }
    }
  };
}

createFilter();
function pluginProxyRemotes (options) {
  var remotes = options.remotes;
  return {
    name: "proxyRemotes",
    config: function config(_config, _ref) {
      var _command = _ref.command;
      Object.keys(remotes).forEach(function (key) {
        var remote = remotes[key];
        _config.resolve.alias.push({
          find: new RegExp("^(" + remote.name + "(/.*|$))"),
          replacement: "$1",
          customResolver: function customResolver(source) {
            var remoteModule = getRemoteVirtualModule(source, _command);
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
var PromiseStore = /*#__PURE__*/function () {
  function PromiseStore() {
    this.promiseMap = new Map();
    this.resolveMap = new Map();
  }
  var _proto = PromiseStore.prototype;
  _proto.set = function set(id, promise) {
    if (this.resolveMap.has(id)) {
      promise.then(this.resolveMap.get(id));
      this.resolveMap["delete"](id);
    }
    this.promiseMap.set(id, promise);
  };
  _proto.get = function get(id) {
    var _this = this;
    if (this.promiseMap.has(id)) {
      return this.promiseMap.get(id);
    }
    var pendingPromise = new Promise(function (resolve) {
      _this.resolveMap.set(id, resolve);
    });
    this.promiseMap.set(id, pendingPromise);
    return pendingPromise;
  };
  return PromiseStore;
}();

function proxySharedModule(options) {
  var _options$shared = options.shared,
    shared = _options$shared === void 0 ? {} : _options$shared;
  return [{
    name: "generateLocalSharedImportMap",
    enforce: "post",
    load: function load(id) {
      if (id.includes(getLocalSharedImportMapPath())) {
        return parsePromise.then(function (_) {
          return generateLocalSharedImportMap();
        });
      }
    },
    transform: function transform(code, id) {
      if (id.includes(getLocalSharedImportMapPath())) {
        return parsePromise.then(function (_) {
          return generateLocalSharedImportMap();
        });
      }
    }
  }, {
    name: 'proxyPreBuildShared',
    enforce: 'post',
    config: function config(_config, _ref) {
      var _config$resolve$alias, _config$resolve$alias2;
      var command = _ref.command;
      (_config$resolve$alias = _config.resolve.alias).push.apply(_config$resolve$alias, Object.keys(shared).map(function (key) {
        var pattern = key.endsWith("/") ? "(^" + key.replace(/\/$/, "") + "(/.+)?$)" : "(^" + key + "$)";
        return {
          // Intercept all shared requests and proxy them to loadShare
          find: new RegExp(pattern),
          replacement: "$1",
          customResolver: function customResolver(source, importer) {
            var loadSharePath = getLoadShareModulePath(source);
            writeLoadShareModule(source, shared[key], command);
            writePreBuildLibPath(source);
            addUsedShares(source);
            writeLocalSharedImportMap();
            return this.resolve(loadSharePath);
          }
        };
      }));
      var savePrebuild = new PromiseStore();
      (_config$resolve$alias2 = _config.resolve.alias).push.apply(_config$resolve$alias2, Object.keys(shared).map(function (key) {
        return command === "build" ? {
          find: new RegExp("(.*" + PREBUILD_TAG + ".*)"),
          replacement: function replacement($1) {
            var pkgName = VirtualModule.findModule(PREBUILD_TAG, $1).name;
            return pkgName;
          }
        } : {
          find: new RegExp("(.*" + PREBUILD_TAG + ".*)"),
          replacement: "$1",
          customResolver: function customResolver(source, importer) {
            try {
              var _this = this;
              var pkgName = VirtualModule.findModule(PREBUILD_TAG, source).name;
              if (importer.includes(LOAD_SHARE_TAG)) {
                // save pre-bunding module id
                savePrebuild.set(pkgName, _this.resolve(pkgName).then(function (item) {
                  return item.id;
                }));
              }
              // Fix localSharedImportMap import id
              var _resolve = _this.resolve;
              return Promise.resolve(savePrebuild.get(pkgName)).then(function (_savePrebuild$get) {
                return Promise.resolve(_resolve.call(_this, _savePrebuild$get));
              });
            } catch (e) {
              return Promise.reject(e);
            }
          }
        };
      }));
    }
  }, {
    name: "watchLocalSharedImportMap",
    apply: "serve",
    config: function config(_config2) {
      _config2.optimizeDeps = defu(_config2.optimizeDeps, {
        exclude: [getLocalSharedImportMapPath()]
      });
      _config2.server = defu(_config2.server, {
        watch: {
          ignored: []
        }
      });
      var watch = _config2.server.watch;
      watch.ignored = [].concat(watch.ignored);
      watch.ignored.push("!**" + getLocalSharedImportMapPath() + "**");
    }
  }];
}

var aliasToArrayPlugin = {
  name: 'alias-transform-plugin',
  config: function config(_config, _ref) {
    if (!_config.resolve) _config.resolve = {};
    if (!_config.resolve.alias) _config.resolve.alias = [];
    var alias = _config.resolve.alias;
    if (typeof alias === 'object' && !Array.isArray(alias)) {
      _config.resolve.alias = Object.entries(alias).map(function (_ref2) {
        var find = _ref2[0],
          replacement = _ref2[1];
        return {
          find: find,
          replacement: replacement
        };
      });
    }
  }
};

var normalizeOptimizeDepsPlugin = {
  name: 'normalizeOptimizeDeps',
  config: function config(_config, _ref) {
    var optimizeDeps = _config.optimizeDeps;
    if (!optimizeDeps) {
      _config.optimizeDeps = {};
      optimizeDeps = _config.optimizeDeps;
    }
    // todo: fix this workaround
    optimizeDeps.force = true;
    if (!optimizeDeps.include) optimizeDeps.include = [];
    if (!optimizeDeps.needsInterop) optimizeDeps.needsInterop = [];
  }
};

function federation(mfUserOptions) {
  var options = normalizeModuleFederationOptions(mfUserOptions);
  initVirtualModules();
  var name = options.name,
    shared = options.shared,
    filename = options.filename;
  if (!name) throw new Error("name is required");
  return [aliasToArrayPlugin, normalizeOptimizeDepsPlugin].concat(addEntry({
    entryName: 'remoteEntry',
    entryPath: REMOTE_ENTRY_ID,
    fileName: filename
  }), addEntry({
    entryName: 'hostInit',
    entryPath: getHostAutoInitPath()
  }), [pluginProxyRemoteEntry(), pluginProxyRemotes(options)], pluginModuleParseEnd(function (id) {
    return id.includes(getHostAutoInitImportId()) || id.includes(REMOTE_ENTRY_ID) || id.includes(getLocalSharedImportMapPath());
  }), proxySharedModule({
    shared: shared
  }), [PluginDevProxyModuleTopLevelAwait(), {
    name: 'module-federation-vite',
    enforce: 'post',
    config: function config(_config, _ref) {
      var _config$optimizeDeps;
      _config.resolve.alias.push({
        find: '@module-federation/runtime',
        replacement: require.resolve('@module-federation/runtime')
      });
      (_config$optimizeDeps = _config.optimizeDeps) == null || (_config$optimizeDeps = _config$optimizeDeps.include) == null || _config$optimizeDeps.push('@module-federation/runtime');
    }
  }], Manifest());
}

export { federation };

/**
 * Even the resolveId hook cannot interfere with vite pre-build,
 * and adding query parameter virtual modules will also fail.
 * You can only proxy to the real file through alias
 */
/**
* shared will be proxied:
* 1. __prebuild__: export shareModule (pre-built source code of modules such as vue, react, etc.)
* 2. __loadShare__: load shareModule (mfRuntime.loadShare('vue'))
*/

import { parsePromise } from "../plugins/pluginModuleParseEnd";
import { getLocalSharedImportMapPath_windows, writeLocalSharedImportMap_windows } from "../utils/localSharedImportMap_windows";
import { getNormalizeModuleFederationOptions, ShareItem } from "../utils/normalizeModuleFederationOptions";
import { removePathFromNpmPackage } from "../utils/packageNameUtils";
import VirtualModule from "../utils/VirtualModule";

// *** __prebuild__
const preBuildCacheMap: Record<string, VirtualModule> = {}
export const PREBUILD_TAG = "__prebuild__"
export function writePreBuildLibPath(pkg: string) {
  if (!preBuildCacheMap[pkg]) preBuildCacheMap[pkg] = new VirtualModule(PREBUILD_TAG + pkg)
  preBuildCacheMap[pkg].writeSync("")
}
export function getPreBuildLibImportId(pkg: string): string {
  if (!preBuildCacheMap[pkg]) preBuildCacheMap[pkg] = new VirtualModule(PREBUILD_TAG + pkg)
  const importId = preBuildCacheMap[pkg].getImportId()
  return importId
}
let shareds: Set<string> = new Set()
export function addShare(pkg: string) {
  shareds.add(pkg)
}

// *** Expose locally provided shared modules here
export const localSharedImportMapModule = new VirtualModule("localSharedImportMap")
localSharedImportMapModule.writeSync("")
export function getLocalSharedImportMapPath() {
  if (process.platform === "win32") {
    return getLocalSharedImportMapPath_windows(localSharedImportMapModule)
  }
  return localSharedImportMapModule.getPath()
}
let prevSharedCount = 0
export async function writeLocalSharedImportMap() {
  const sharedCount = shareds.size
  if (prevSharedCount !== sharedCount) {
    prevSharedCount = sharedCount
    if (process.platform === "win32") {
      return writeLocalSharedImportMap_windows(localSharedImportMapModule, await generateLocalSharedImportMap())
    }
    return localSharedImportMapModule.writeSync(await generateLocalSharedImportMap(), true)
  }
}
export async function generateLocalSharedImportMap() {
  await parsePromise
  const options = getNormalizeModuleFederationOptions()
  return `
    const localSharedImportMap = {
      ${Array.from(shareds).map(pkg => `
        ${JSON.stringify(pkg)}: async () => {
          let pkg = await import("${getPreBuildLibImportId(pkg)}")
          return pkg
        }
      `).join(",")}
    }
      const localShared = {
      ${Array.from(shareds)
      .map((key) => {
        const shareItem = options.shared[removePathFromNpmPackage(key)] || options.shared[removePathFromNpmPackage(key) + "/"];
        return `
          ${JSON.stringify(key)}: {
            name: ${JSON.stringify(key)},
            version: ${JSON.stringify(shareItem.version)},
            scope: [${JSON.stringify(shareItem.scope)}],
            loaded: false,
            from: ${JSON.stringify(options.name)},
            async get () {
              localShared[${JSON.stringify(key)}].loaded = true
              const {${JSON.stringify(key)}: pkgDynamicImport} = localSharedImportMap 
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
      })
      .join(',')}
    }
      export default localShared
      `
}

// *** __loadShare__
export const LOAD_SHARE_TAG = "__loadShare__"

const loadShareCacheMap: Record<string, VirtualModule> = {}
export function getLoadShareModulePath(pkg: string): string {
  if (!loadShareCacheMap[pkg]) loadShareCacheMap[pkg] = new VirtualModule(LOAD_SHARE_TAG + pkg)
  const filepath = loadShareCacheMap[pkg].getPath()
  return filepath
}
export function writeLoadShareModule(pkg: string, shareItem: ShareItem, command: string) {
  loadShareCacheMap[pkg].writeSync(`
    () => import(${JSON.stringify(getPreBuildLibImportId(pkg))}).catch(() => {});
    // dev uses dynamic import to separate chunks
    ${command !== "build" ? `;() => import(${JSON.stringify(pkg)}).catch(() => {});` : ''}
    const {loadShare} = require("@module-federation/runtime")
    const res = loadShare(${JSON.stringify(pkg)}, {
    customShareInfo: {shareConfig:{
      singleton: ${shareItem.shareConfig.singleton},
      strictVersion: ${shareItem.shareConfig.strictVersion},
      requiredVersion: ${JSON.stringify(shareItem.shareConfig.requiredVersion)}
    }}})
    const exportModule = ${command !== "build" ? "/*mf top-level-await placeholder replacement mf*/" : "await "}res.then(factory => factory())
    module.exports = exportModule
  `)
}

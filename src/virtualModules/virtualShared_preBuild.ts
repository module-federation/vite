/**
 * Even the resolveId hook cannot interfere with vite pre-build,
 * and adding query parameter virtual modules will also fail.
 * You can only proxy to the real file through alias
 */

// import { parsePromise } from "../plugins/pluginModuleParseEnd";
import { parsePromise } from "../plugins/pluginModuleParseEnd";
import { getNormalizeModuleFederationOptions, ShareItem } from "../utils/normalizeModuleFederationOptions";
import { removePathFromNpmPackage } from "../utils/packageNameUtils";
import VirtualModule from "../utils/VirtualModule";

const cacheMap2: Record<string, VirtualModule> = {}
export const PREBUILD_TAG = "__prebuild__"
// this is the proxied module, react, vue and other modules
export function getPreBuildLibPath(pkg: string): string {
  if (!cacheMap2[pkg]) cacheMap2[pkg] = new VirtualModule(PREBUILD_TAG + pkg)
  const filepath = cacheMap2[pkg].getPath()
  return filepath
}
export function writePreBuildLibPath(pkg: string) {
  cacheMap2[pkg].writeSync("")
}

let shareds: Record<string, null> = {}

// All proxied modules are exposed here
export const localSharedImportMapModule = new VirtualModule("localSharedImportMap")
localSharedImportMapModule.writeSync("")
export function getLocalSharedImportMapId() {
  return localSharedImportMapModule.getPath()
}
let prevSharedCount = 0
export async function writeLocalSharedImportMap() {
  if (prevSharedCount !== Object.keys(shareds).length) {
    return localSharedImportMapModule.writeSync(await generateLocalSharedImportMap())
  }
}

export async function generateLocalSharedImportMap() {
  await parsePromise
  const options = getNormalizeModuleFederationOptions()
  return `
    const localSharedImportMap = {
      ${Object.keys(shareds).map(pkg => `
        ${JSON.stringify(pkg)}: async () => {
          let pkg = await import("${getPreBuildLibImportId(pkg)}")
          return pkg
        }
      `).join(",")}
    }
      const localShared = {
      ${Object.keys(shareds)
      .map((key) => {
        const shareItem = options.shared[removePathFromNpmPackage(key)];
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

export const LOAD_SHARE_TAG = "__loadShare__"
/**
 * generate loadShare virtual module
 */
const cacheMap1: Record<string, VirtualModule> = {}
export function getLoadShareModulePath(pkg: string): string {
  if (!cacheMap1[pkg]) cacheMap1[pkg] = new VirtualModule(LOAD_SHARE_TAG + pkg)
  const filepath = cacheMap1[pkg].getPath()
  return filepath
}
export function getPreBuildLibImportId(pkg: string): string {
  if (!cacheMap2[pkg]) cacheMap2[pkg] = new VirtualModule(PREBUILD_TAG + pkg)
  const importId = cacheMap2[pkg].getImportId()
  return importId
}
export function writeLoadShareModule(pkg: string, shareItem: ShareItem, command: string) {
  cacheMap1[pkg].writeSync(`
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


export function addShare(pkg: string) {
  shareds[pkg] = null
}
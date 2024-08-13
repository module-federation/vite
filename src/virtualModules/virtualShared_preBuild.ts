/**
 * Even the resolveId hook cannot interfere with vite pre-build,
 * and adding query parameter virtual modules will also fail.
 * You can only proxy to the real file through alias
 */

import { writeFileSync } from "fs";
import { resolve } from "pathe";
import { getNormalizeModuleFederationOptions, ShareItem } from "../utils/normalizeModuleFederationOptions";
const emptyNpmDir = resolve(require.resolve("an-empty-js-file"), "../")

/**
 * The original shared module is proxied by getLoadShareModulePath, and the new shared module is prebuilt here
 */
const cacheMap2: Record<string, string> = {}
export function getPreBuildLibPath(pkg: string): string {
  if (!cacheMap2[pkg]) cacheMap2[pkg] = `__mf__prebuildwrap_${npmPackageNameToFileName(pkg)}.js`
  const filename = cacheMap2[pkg]
  return filename
}

function getLocalSharedImportMapFileName() {
  const { name } = getNormalizeModuleFederationOptions()
  return npmPackageNameToFileName(name) + "_" + "__mf__localSharedImportMap.js"
}
// Only npm package name import can trigger pre-build, absolute path cannot
export function getLocalSharedImportMapId() {
  return `an-empty-js-file/${getLocalSharedImportMapFileName()}`
}
export function getLocalSharedImportMapPath() {
  return resolve(emptyNpmDir, getLocalSharedImportMapFileName())
}
export function writeLocalSharedImportMap(pkgList: string[]) {
  writeFileSync(getLocalSharedImportMapPath(), `
    export default {
      ${pkgList.map(pkg => `
        ${JSON.stringify(pkg)}: async () => {
          let pkg = await import("${getPreBuildLibPath(pkg)}")
          return pkg
        }
      `).join(",")}
    }
    `)
}

/**
 * generate loadShare virtual module
 */
const cacheMap1: Record<string, string> = {}
export function getLoadShareModulePath(pkg: string): string {
  const { name } = getNormalizeModuleFederationOptions()
  if (!cacheMap1[pkg]) cacheMap1[pkg] = npmPackageNameToFileName(name) + "_" + `__mf__loadShare_${npmPackageNameToFileName(pkg)}.js`
  const filename = cacheMap1[pkg]
  return resolve(emptyNpmDir, filename)
}
export function writeLoadShareModule(pkg: string, shareItem: ShareItem, command: string) {

  writeFileSync(getLoadShareModulePath(pkg), `
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

function npmPackageNameToFileName(packageName: string) {
  // 1. 去掉包名前的 "@"
  // 2. 将包名中的 "/" 替换为 "__" 以避免文件路径问题
  // 3. 去掉不合法的文件名字符
  return packageName
    .replace(/^@/, '')      // 移除作用域前缀 "@"
    .replace(/\//g, '__')   // 将 "/" 替换为 "__"
    .replace(/[^a-zA-Z0-9_.-]/g, '_'); // 替换其他非法字符为 "_"
}
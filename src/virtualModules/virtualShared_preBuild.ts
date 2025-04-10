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

import { ShareItem } from '../utils/normalizeModuleFederationOptions';
import VirtualModule from '../utils/VirtualModule';
import { virtualRuntimeInitStatus } from './virtualRuntimeInitStatus';

// *** __prebuild__
const preBuildCacheMap: Record<string, VirtualModule> = {};
export const PREBUILD_TAG = '__prebuild__';
export function writePreBuildLibPath(pkg: string) {
  if (!preBuildCacheMap[pkg]) preBuildCacheMap[pkg] = new VirtualModule(pkg, PREBUILD_TAG);
  preBuildCacheMap[pkg].writeSync('');
}
export function getPreBuildLibImportId(pkg: string): string {
  if (!preBuildCacheMap[pkg]) preBuildCacheMap[pkg] = new VirtualModule(pkg, PREBUILD_TAG);
  const importId = preBuildCacheMap[pkg].getImportId();
  return importId;
}

// *** __loadShare__
export const LOAD_SHARE_TAG = '__loadShare__';

const loadShareCacheMap: Record<string, VirtualModule> = {};
export function getLoadShareModulePath(pkg: string): string {
  if (!loadShareCacheMap[pkg])
    loadShareCacheMap[pkg] = new VirtualModule(pkg, LOAD_SHARE_TAG, '.js');
  const filepath = loadShareCacheMap[pkg].getPath();
  return filepath;
}
export function writeLoadShareModule(pkg: string, shareItem: ShareItem, command: string) {
  loadShareCacheMap[pkg].writeSync(`
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    ;() => import(${JSON.stringify(getPreBuildLibImportId(pkg))}).catch(() => {});
    // dev uses dynamic import to separate chunks
    ${command !== 'build' ? `;() => import(${JSON.stringify(pkg)}).catch(() => {});` : ''}
    const {loadShare} = require("@module-federation/runtime")
    const {initPromise} = require("${virtualRuntimeInitStatus.getImportId()}")
    const res = initPromise.then(_ => loadShare(${JSON.stringify(pkg)}, {
    customShareInfo: {shareConfig:{
      singleton: ${shareItem.shareConfig.singleton},
      strictVersion: ${shareItem.shareConfig.strictVersion},
      requiredVersion: ${JSON.stringify(shareItem.shareConfig.requiredVersion)}
    }}}))
    
    // Dual exports for CJS/ESM compatibility
    if (typeof module !== 'undefined') {
      module.exports = exportModule;
      module.exports.default = exportModule;
    }
    
    // ESM export fallback
    if (typeof exports !== 'undefined' && typeof define !== 'function') {
      Object.defineProperty(exports, '__esModule', { value: true });
      exports.default = exportModule;
    }
  `);
}

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

import { createRequire } from 'module';
import { ShareItem } from '../utils/normalizeModuleFederationOptions';
import { hasPackageDependency } from '../utils/packageUtils';
import VirtualModule from '../utils/VirtualModule';
import {
  getRuntimeInitBootstrapCode,
  getRuntimeInitPromiseBootstrapCode,
  virtualRuntimeInitStatus,
} from './virtualRuntimeInitStatus';

function getPackageNamedExports(pkg: string): string[] {
  try {
    // Resolve from the project root (process.cwd()) so that shared packages
    // like react are found even when the plugin is installed in a nested
    // pnpm store location where peer dependencies are not hoisted.
    const projectRequire = createRequire(new URL('file://' + process.cwd() + '/package.json'));
    const mod = projectRequire(pkg);
    return Object.keys(mod).filter(
      (k) => k !== 'default' && k !== '__esModule' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k)
    );
  } catch {
    return [];
  }
}

function getLocalProviderImportPath(pkg: string): string | undefined {
  try {
    const projectRequire = createRequire(new URL('file://' + process.cwd() + '/package.json'));
    const resolved = projectRequire.resolve(pkg);
    return resolved.includes('/node_modules/') || resolved.includes('\\node_modules\\')
      ? undefined
      : resolved;
  } catch {
    return undefined;
  }
}

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
export function getLoadShareImportId(pkg: string, isRolldown: boolean, command?: string): string {
  if (!loadShareCacheMap[pkg]) {
    const useESM = isRolldown || command === 'build';
    const ext = useESM ? '.mjs' : '.js';
    loadShareCacheMap[pkg] = new VirtualModule(pkg, LOAD_SHARE_TAG, ext);
  }
  return loadShareCacheMap[pkg].getImportId();
}
export function getLoadShareModulePath(pkg: string, isRolldown: boolean, command?: string): string {
  if (!loadShareCacheMap[pkg]) getLoadShareImportId(pkg, isRolldown, command);
  const filepath = loadShareCacheMap[pkg].getPath();
  return filepath;
}
export function writeLoadShareModule(
  pkg: string,
  shareItem: ShareItem,
  command: string,
  isRolldown: boolean
) {
  if (!loadShareCacheMap[pkg]) {
    const useESM = isRolldown || command === 'build';
    const ext = useESM ? '.mjs' : '.js';
    loadShareCacheMap[pkg] = new VirtualModule(pkg, LOAD_SHARE_TAG, ext);
  }

  const useESM = command === 'build' || isRolldown;
  const importLine =
    command === 'build'
      ? getRuntimeInitPromiseBootstrapCode()
      : useESM
        ? `${getRuntimeInitBootstrapCode()}
    const { initPromise } = globalThis[globalKey];`
        : `const {initPromise} = require("${virtualRuntimeInitStatus.getImportId()}")`;
  const awaitOrPlaceholder = useESM
    ? 'await '
    : '/*mf top-level-await placeholder replacement mf*/';
  const isVinext = hasPackageDependency('vinext');
  const useSsrProviderFallback = isVinext && command === 'build' && pkg === 'react';
  const providerImportId = getLocalProviderImportPath(pkg) || getPreBuildLibImportId(pkg);
  const namedExports = getPackageNamedExports(pkg);
  let exportLine: string;
  if (namedExports.length > 0) {
    const destructure = `const { ${namedExports.map((name, i) => `${name}: __mf_${i}`).join(', ')} } = exportModule;`;
    const namedExportLine = `export { ${namedExports.map((name, i) => `__mf_${i} as ${name}`).join(', ')} };`;
    exportLine = useESM
      ? `export default exportModule.default ?? exportModule;\n    ${destructure}\n    ${namedExportLine}`
      : `module.exports = exportModule;\n    ${destructure}\n    Object.assign(module.exports, { ${namedExports.map((name, i) => `"${name}": __mf_${i}`).join(', ')} });`;
  } else {
    exportLine = useESM
      ? `export default exportModule.default ?? exportModule\n    export * from ${JSON.stringify(getPreBuildLibImportId(pkg))}`
      : 'module.exports = exportModule';
  }

  loadShareCacheMap[pkg].writeSync(`
    import ${JSON.stringify(getPreBuildLibImportId(pkg))};
    ${command !== 'build' ? `;() => import(${JSON.stringify(pkg)}).catch(() => {});` : ''}
    ${importLine}
    ${
      useSsrProviderFallback
        ? `const providerModulePromise = typeof window === "undefined"
      ? import(${JSON.stringify(providerImportId)})
      : undefined`
        : ''
    }
    const res = initPromise.then(runtime => runtime.loadShare(${JSON.stringify(pkg)}, {
      customShareInfo: {shareConfig:{
        singleton: ${shareItem.shareConfig.singleton},
        strictVersion: ${shareItem.shareConfig.strictVersion},
        requiredVersion: ${JSON.stringify(shareItem.shareConfig.requiredVersion)}
      }}
    }))
    const exportModule = ${
      useSsrProviderFallback
        ? `(typeof window === "undefined"
      ? ((await providerModulePromise)?.default ?? await providerModulePromise)
      : ${awaitOrPlaceholder}res.then((factory) => (typeof factory === "function" ? factory() : factory)))`
        : `${awaitOrPlaceholder}res.then((factory) => (typeof factory === "function" ? factory() : factory))`
    }
    ${exportLine}
  `);
}

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
import VirtualModule from '../utils/VirtualModule';
import { virtualRuntimeInitStatus } from './virtualRuntimeInitStatus';

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

// *** __prebuild__
const preBuildCacheMap: Record<string, VirtualModule> = {};
export const PREBUILD_TAG = '__prebuild__';
export function writePreBuildLibPath(pkg: string, force?: boolean) {
  if (!preBuildCacheMap[pkg]) preBuildCacheMap[pkg] = new VirtualModule(pkg, PREBUILD_TAG);
  preBuildCacheMap[pkg].writeSync('', force);
}
export function getPreBuildLibImportId(pkg: string): string {
  if (!preBuildCacheMap[pkg]) preBuildCacheMap[pkg] = new VirtualModule(pkg, PREBUILD_TAG);
  const importId = preBuildCacheMap[pkg].getImportId();
  return importId;
}

// *** __loadShare__
export const LOAD_SHARE_TAG = '__loadShare__';

const loadShareCacheMap: Record<string, VirtualModule> = {};
export function getLoadShareModulePath(pkg: string, isRolldown: boolean, command?: string): string {
  if (!loadShareCacheMap[pkg]) {
    // Use .mjs for build mode (ESM code) so @rollup/plugin-commonjs skips it.
    // Without this, the CJS plugin creates a commonjs-proxy that shares helpers
    // (getDefaultExportFromCjs) with prebuild chunks, creating a transitive
    // dependency: prebuild → proxy → loadShare (TLA) → deadlock.
    const useESM = isRolldown || command === 'build';
    const ext = useESM ? '.mjs' : '.js';
    loadShareCacheMap[pkg] = new VirtualModule(pkg, LOAD_SHARE_TAG, ext);
  }
  const filepath = loadShareCacheMap[pkg].getPath();
  return filepath;
}
export function writeLoadShareModule(
  pkg: string,
  shareItem: ShareItem,
  command: string,
  isRolldown: boolean,
  force?: boolean
) {
  if (!loadShareCacheMap[pkg]) {
    const useESM = isRolldown || command === 'build';
    const ext = useESM ? '.mjs' : '.js';
    loadShareCacheMap[pkg] = new VirtualModule(pkg, LOAD_SHARE_TAG, ext);
  }

  const useESM = command === 'build' || isRolldown;
  const importLine = useESM
    ? `import { initPromise } from "${virtualRuntimeInitStatus.getImportId()}"`
    : `const {initPromise} = require("${virtualRuntimeInitStatus.getImportId()}")`;
  const awaitOrPlaceholder = useESM
    ? 'await '
    : '/*mf top-level-await placeholder replacement mf*/';
  const namedExports = getPackageNamedExports(pkg);
  let exportLine: string;
  if (namedExports.length > 0) {
    const destructure = `const { ${namedExports.map((name, i) => `${name}: __mf_${i}`).join(', ')} } = exportModule;`;
    const namedExportLine = `export { ${namedExports.map((name, i) => `__mf_${i} as ${name}`).join(', ')} };`;
    exportLine = useESM
      ? `export default exportModule;\n    ${destructure}\n    ${namedExportLine}`
      : `module.exports = exportModule;\n    ${destructure}\n    Object.assign(module.exports, { ${namedExports.map((name, i) => `"${name}": __mf_${i}`).join(', ')} });`;
  } else {
    exportLine = useESM
      ? `export default exportModule\n    export * from ${JSON.stringify(getPreBuildLibImportId(pkg))}`
      : 'module.exports = exportModule';
  }

  loadShareCacheMap[pkg].writeSync(
    `
    import ${JSON.stringify(getPreBuildLibImportId(pkg))};
    ${command !== 'build' ? `;() => import(${JSON.stringify(pkg)}).catch(() => {});` : ''}
    ${importLine}
    const res = initPromise.then(runtime => runtime.loadShare(${JSON.stringify(pkg)}, {
      customShareInfo: {shareConfig:{
        singleton: ${shareItem.shareConfig.singleton},
        strictVersion: ${shareItem.shareConfig.strictVersion},
        requiredVersion: ${JSON.stringify(shareItem.shareConfig.requiredVersion)}
      }}
    }))
    const exportModule = ${awaitOrPlaceholder}res.then((factory) => (typeof factory === "function" ? factory() : factory))
    ${exportLine}
  `,
    force
  );
}

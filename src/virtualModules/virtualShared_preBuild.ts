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

import { existsSync, readFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'pathe';
import {
  getModuleFederationScopeKey,
  getNormalizeModuleFederationOptions,
  ModuleFederationScopeOptions,
  ShareItem,
} from '../utils/normalizeModuleFederationOptions';
import {
  getPackageDetectionCwd,
  hasPackageDependency,
  removePathFromNpmPackage,
} from '../utils/packageUtils';
import VirtualModule from '../utils/VirtualModule';
import {
  getRuntimeInitBootstrapCode,
  getRuntimeInitImportId,
  getRuntimeInitPromiseBootstrapCode,
} from './virtualRuntimeInitStatus';

function escapeGeneratedStringLiteral(value: string): string {
  return JSON.stringify(value).replace(/[<>\u2028\u2029]/g, (char) => {
    switch (char) {
      case '<':
        return '\\u003C';
      case '>':
        return '\\u003E';
      case '\u2028':
        return '\\u2028';
      case '\u2029':
        return '\\u2029';
      default:
        return char;
    }
  });
}

const localRequire = createRequire(import.meta.url);

function resolvePackageEntryFromProjectRoot(pkg: string): string | undefined {
  try {
    const projectRequire = createRequire(
      new URL(`file://${path.join(getPackageDetectionCwd(), 'package.json')}`)
    );
    return projectRequire.resolve(pkg);
  } catch {
    return undefined;
  }
}

function getInstalledPackageJsonPath(pkg: string): string | undefined {
  try {
    const packageName = removePathFromNpmPackage(pkg);
    const projectRequire = createRequire(
      new URL(`file://${path.join(getPackageDetectionCwd(), 'package.json')}`)
    );
    let resolvedPath: string | undefined;

    try {
      resolvedPath = projectRequire.resolve(pkg);
    } catch {
      resolvedPath = projectRequire.resolve(packageName);
    }

    let currentDir = path.dirname(resolvedPath);
    const rootDir = path.parse(currentDir).root;

    while (currentDir !== rootDir) {
      const packageJsonPath = path.join(currentDir, 'package.json');
      if (existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { name?: string };
        if (packageJson.name === packageName) return packageJsonPath;
      }
      currentDir = path.dirname(currentDir);
    }

    const rootPackageJsonPath = path.join(rootDir, 'package.json');
    if (existsSync(rootPackageJsonPath)) {
      const packageJson = JSON.parse(readFileSync(rootPackageJsonPath, 'utf-8')) as {
        name?: string;
      };
      if (packageJson.name === packageName) return rootPackageJsonPath;
    }
  } catch {
    const packageName = removePathFromNpmPackage(pkg);
    let currentDir = getPackageDetectionCwd();
    const rootDir = path.parse(currentDir).root;

    while (currentDir !== rootDir) {
      const packageJsonPath = path.join(currentDir, 'node_modules', packageName, 'package.json');
      if (existsSync(packageJsonPath)) return packageJsonPath;
      currentDir = path.dirname(currentDir);
    }

    const rootPackageJsonPath = path.join(rootDir, 'node_modules', packageName, 'package.json');
    return existsSync(rootPackageJsonPath) ? rootPackageJsonPath : undefined;
  }
}

function resolveImportTarget(exportsField: unknown): string | undefined {
  if (typeof exportsField === 'string') return exportsField;
  if (!exportsField || typeof exportsField !== 'object') return undefined;

  const record = exportsField as Record<string, unknown>;
  const preferredConditions = ['import', 'module', 'default'];
  for (const condition of preferredConditions) {
    const target = resolveImportTarget(record[condition]);
    if (target) return target;
  }

  for (const target of Object.values(record)) {
    const resolved = resolveImportTarget(target);
    if (resolved) return resolved;
  }

  return undefined;
}

function getPackageEsmEntryPath(pkg: string): string | undefined {
  try {
    const resolvedEntryPath = resolvePackageEntryFromProjectRoot(pkg);
    const packageJsonPath = getInstalledPackageJsonPath(pkg);
    if (!packageJsonPath) return resolvedEntryPath;

    const packageName = removePathFromNpmPackage(pkg);
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
      exports?: Record<string, unknown> | string;
      module?: string;
    };
    const subpath = pkg === packageName ? '.' : `.${pkg.slice(packageName.length)}`;

    const exportsField =
      typeof packageJson.exports === 'string'
        ? subpath === '.'
          ? packageJson.exports
          : undefined
        : (packageJson.exports?.[subpath] ??
          (subpath === '.'
            ? (packageJson.exports?.['.'] ??
              (packageJson.exports &&
              !Object.keys(packageJson.exports).some((key) => key.startsWith('.'))
                ? packageJson.exports
                : undefined))
            : undefined));

    const target = resolveImportTarget(exportsField) || packageJson.module;
    if (!target) return resolvedEntryPath;

    return path.resolve(path.dirname(packageJsonPath), target);
  } catch {
    return resolvePackageEntryFromProjectRoot(pkg);
  }
}

function getEsmNamedExports(pkg: string): string[] {
  try {
    const entryPath = getPackageEsmEntryPath(pkg);
    if (!entryPath) return [];

    const { initSync, parse } = localRequire('es-module-lexer') as typeof import('es-module-lexer');
    initSync();
    const source = readFileSync(entryPath, 'utf-8');
    const [, exports] = parse(source, entryPath);

    return exports
      .map((item) => item.n)
      .filter(
        (name): name is string =>
          !!name &&
          name !== 'default' &&
          name !== '__esModule' &&
          /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
      );
  } catch {
    return [];
  }
}

function getPackageNamedExports(pkg: string): string[] {
  try {
    // Resolve from the project root (process.cwd()) so that shared packages
    // like react are found even when the plugin is installed in a nested
    // pnpm store location where peer dependencies are not hoisted.
    const projectRequire = createRequire(
      new URL(`file://${path.join(getPackageDetectionCwd(), 'package.json')}`)
    );
    const mod = projectRequire(pkg);
    return Object.keys(mod).filter(
      (k) => k !== 'default' && k !== '__esModule' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k)
    );
  } catch {
    return getEsmNamedExports(pkg);
  }
}

function getLocalProviderImportPath(pkg: string): string | undefined {
  try {
    const projectRequire = createRequire(
      new URL(`file://${path.join(getPackageDetectionCwd(), 'package.json')}`)
    );
    const resolved = projectRequire.resolve(pkg);
    return resolved.includes('/node_modules/') || resolved.includes('\\node_modules\\')
      ? undefined
      : resolved;
  } catch {
    return undefined;
  }
}

function tryResolveImportFromPackageRoot(pkg: string, root: string): string | undefined {
  try {
    const projectRequire = createRequire(new URL(`file://${path.join(root, 'package.json')}`));
    return projectRequire.resolve(pkg);
  } catch {
    return undefined;
  }
}

export function getConcreteSharedImportSource(
  pkg: string,
  shareItem?: ShareItem
): string | undefined {
  const configuredImport = shareItem?.shareConfig.import;
  if (typeof configuredImport === 'string') return configuredImport;

  const projectRoot = getPackageDetectionCwd();
  if (tryResolveImportFromPackageRoot(pkg, projectRoot)) {
    return undefined;
  }

  let currentDir = path.dirname(projectRoot);
  while (currentDir !== path.dirname(currentDir)) {
    const resolved = tryResolveImportFromPackageRoot(pkg, currentDir);
    if (resolved) return resolved;
    currentDir = path.dirname(currentDir);
  }

  return tryResolveImportFromPackageRoot(pkg, currentDir);
}

function resolveScopeOptions(options?: ModuleFederationScopeOptions): ModuleFederationScopeOptions {
  return options || getNormalizeModuleFederationOptions();
}

function getScopedSharedKey(pkg: string, options?: ModuleFederationScopeOptions) {
  return `${getModuleFederationScopeKey(resolveScopeOptions(options))}:${pkg}`;
}

function getLoadShareCacheKey(
  pkg: string,
  command: string | undefined,
  isRolldown: boolean,
  options?: ModuleFederationScopeOptions
) {
  const format = isRolldown || command === 'build' ? 'esm' : 'cjs';
  return `${getScopedSharedKey(pkg, options)}:${format}`;
}

function createScopedVirtualModule(
  pkg: string,
  tag: string,
  suffix: string,
  options?: ModuleFederationScopeOptions
) {
  const resolvedOptions = resolveScopeOptions(options);
  return new VirtualModule(pkg, tag, suffix, {
    name: resolvedOptions.name,
    virtualModuleDir: resolvedOptions.virtualModuleDir,
  });
}

// *** __prebuild__
const preBuildCacheMap = new Map<string, VirtualModule>();
const preBuildShareItemMap = new Map<string, ShareItem | undefined>();
export const PREBUILD_TAG = '__prebuild__';
export function writePreBuildLibPath(
  pkg: string,
  shareItem?: ShareItem,
  options?: ModuleFederationScopeOptions
) {
  const scopedKey = getScopedSharedKey(pkg, options);
  let preBuildModule = preBuildCacheMap.get(scopedKey);

  if (!preBuildModule) {
    preBuildModule = createScopedVirtualModule(pkg, PREBUILD_TAG, '', options);
    preBuildCacheMap.set(scopedKey, preBuildModule);
  }

  preBuildShareItemMap.set(scopedKey, shareItem);
  preBuildModule.writeSync('', true);
}
export function getPreBuildLibImportId(
  pkg: string,
  options?: ModuleFederationScopeOptions
): string {
  const scopedKey = getScopedSharedKey(pkg, options);
  let preBuildModule = preBuildCacheMap.get(scopedKey);

  if (!preBuildModule) {
    preBuildModule = createScopedVirtualModule(pkg, PREBUILD_TAG, '', options);
    preBuildCacheMap.set(scopedKey, preBuildModule);
  }

  preBuildModule.writeSync('');
  const importId = preBuildModule.getImportId();
  return importId;
}
export function getPreBuildShareItem(
  pkg: string,
  options?: ModuleFederationScopeOptions
): ShareItem | undefined {
  return preBuildShareItemMap.get(getScopedSharedKey(pkg, options));
}

export function getSharedImportSource(
  pkg: string,
  shareItem?: ShareItem,
  options?: ModuleFederationScopeOptions
): string {
  return getConcreteSharedImportSource(pkg, shareItem) || getPreBuildLibImportId(pkg, options);
}

// *** __loadShare__
export const LOAD_SHARE_TAG = '__loadShare__';

const loadShareCacheMap = new Map<string, VirtualModule>();
export function getLoadShareImportId(
  pkg: string,
  isRolldown: boolean,
  command?: string,
  options?: ModuleFederationScopeOptions
): string {
  const cacheKey = getLoadShareCacheKey(pkg, command, isRolldown, options);
  let loadShareModule = loadShareCacheMap.get(cacheKey);

  if (!loadShareModule) {
    const useESM = isRolldown || command === 'build';
    const ext = useESM ? '.mjs' : '.js';
    loadShareModule = createScopedVirtualModule(pkg, LOAD_SHARE_TAG, ext, options);
    loadShareCacheMap.set(cacheKey, loadShareModule);
  }

  return loadShareModule.getImportId();
}
export function getLoadShareModulePath(
  pkg: string,
  isRolldown: boolean,
  command?: string,
  options?: ModuleFederationScopeOptions
): string {
  const cacheKey = getLoadShareCacheKey(pkg, command, isRolldown, options);
  if (!loadShareCacheMap.has(cacheKey)) getLoadShareImportId(pkg, isRolldown, command, options);
  const filepath = loadShareCacheMap.get(cacheKey)!.getPath();
  return filepath;
}
export function writeLoadShareModule(
  pkg: string,
  shareItem: ShareItem,
  command: string,
  isRolldown: boolean,
  options?: ModuleFederationScopeOptions
) {
  const cacheKey = getLoadShareCacheKey(pkg, command, isRolldown, options);
  let loadShareModule = loadShareCacheMap.get(cacheKey);

  if (!loadShareModule) {
    const useESM = isRolldown || command === 'build';
    const ext = useESM ? '.mjs' : '.js';
    loadShareModule = createScopedVirtualModule(pkg, LOAD_SHARE_TAG, ext, options);
    loadShareCacheMap.set(cacheKey, loadShareModule);
  }

  const useESM = command === 'build' || isRolldown;
  const importLine =
    command === 'build'
      ? getRuntimeInitPromiseBootstrapCode(options)
      : useESM
        ? `${getRuntimeInitBootstrapCode(options)}
    const { initPromise } = globalThis[globalKey];`
        : `const {initPromise} = require("${getRuntimeInitImportId(command, options)}")`;
  const awaitOrPlaceholder = useESM
    ? 'await '
    : '/*mf top-level-await placeholder replacement mf*/';
  const isVinext = hasPackageDependency('vinext');
  const useSsrProviderFallback = isVinext && command === 'build' && pkg === 'react';
  const concreteSharedImportSource = getConcreteSharedImportSource(pkg, shareItem);
  const sharedImportSource = concreteSharedImportSource || getPreBuildLibImportId(pkg, options);
  const devImportSource = concreteSharedImportSource || pkg;
  const providerImportId =
    getLocalProviderImportPath(pkg) || concreteSharedImportSource || sharedImportSource;
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
      ? `export default exportModule.default ?? exportModule\n    export * from ${escapeGeneratedStringLiteral(sharedImportSource)}`
      : 'module.exports = exportModule';
  }

  loadShareModule.writeSync(
    `
    import ${escapeGeneratedStringLiteral(sharedImportSource)};
    ${command !== 'build' ? `;() => import(${escapeGeneratedStringLiteral(devImportSource)}).catch(() => {});` : ''}
    ${importLine}
    ${
      useSsrProviderFallback
        ? `const providerModulePromise = typeof window === "undefined"
      ? import(${escapeGeneratedStringLiteral(providerImportId)})
      : undefined`
        : ''
    }
    const res = initPromise.then(runtime => runtime.loadShare(${escapeGeneratedStringLiteral(pkg)}, {
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
  `,
    true
  );
}

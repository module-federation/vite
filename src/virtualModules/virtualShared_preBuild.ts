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

import { existsSync, readFileSync, statSync } from 'fs';
import { createRequire } from 'module';
import path from 'pathe';
import { initSync, parse } from 'es-module-lexer';
import { mfWarn } from '../utils/logger';
import { ShareItem } from '../utils/normalizeModuleFederationOptions';
import {
  getPackageDetectionCwd,
  hasPackageDependency,
  removePathFromNpmPackage,
} from '../utils/packageUtils';
import VirtualModule from '../utils/VirtualModule';
import {
  getRuntimeInitBootstrapCode,
  getRuntimeInitPromiseBootstrapCode,
  virtualRuntimeInitStatus,
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

let lexerInitialized = false;

const RESOLVE_EXTENSIONS = [
  '',
  '.ts',
  '.js',
  '.mjs',
  '.mts',
  '.cjs',
  '.jsx',
  '.tsx',
  '/index.ts',
  '/index.js',
  '/index.mjs',
  '/index.jsx',
  '/index.tsx',
];

const SOURCE_FALLBACK_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json'];

/**
 * Extract named exports from an ESM/TS source file, recursively following
 * `export * from './...'` re-exports within the same package.
 * Uses a Set to deduplicate (also prevents issues with es-module-lexer
 * reporting the TypeScript `type` keyword as an export name).
 */
function getNamedExportsViaRegex(source: string): string[] {
  const names: string[] = [];

  // Match: export function Foo, export async function Foo, export const Foo, export class Foo, etc.
  // Excludes: export type Foo, export interface Foo, export enum Foo (type-only declarations)
  const declRegex =
    /export\s+(?!type\s|interface\s|enum\s)(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  let match: RegExpExecArray | null;
  while ((match = declRegex.exec(source)) !== null) {
    names.push(match[1]);
  }

  // Match: export { Foo, Bar as Baz } and export { Foo } from '...'
  // Skip: export type { ... } (entire statement is type-only)
  const listRegex = /export\s+(?!type\s*\{)\{([^}]+)\}/g;
  while ((match = listRegex.exec(source)) !== null) {
    const specifiers = match[1].split(',');
    for (const spec of specifiers) {
      const trimmed = spec.trim();
      // Skip inline type specifiers: export { type Foo, Bar }
      if (trimmed.startsWith('type ')) continue;
      const asMatch = trimmed.match(/(?:\S+\s+as\s+)?([A-Za-z_$][A-Za-z0-9_$]*)$/);
      if (asMatch) {
        names.push(asMatch[1]);
      }
    }
  }

  return names.filter((name) => name !== 'default' && name !== '__esModule');
}

function getNamedExportsFromSource(entryPath: string, visited: Set<string> = new Set()): string[] {
  if (!lexerInitialized) {
    initSync();
    lexerInitialized = true;
  }

  const resolved = path.resolve(entryPath);
  if (visited.has(resolved)) return [];
  visited.add(resolved);

  let source: string;
  try {
    source = readFileSync(resolved, 'utf-8');
  } catch {
    return [];
  }

  const names = new Set<string>();

  try {
    const [imports, exports] = parse(source, resolved);

    for (const exp of exports) {
      if (
        exp.n &&
        exp.n !== 'default' &&
        exp.n !== '__esModule' &&
        /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exp.n)
      ) {
        names.add(exp.n);
      }
    }

    // Recursively follow `export * from './relative'` re-exports.
    // In es-module-lexer, imp.t === 1 indicates a re-export statement.
    const RE_EXPORT_TYPE = 1;
    const dir = path.dirname(resolved);
    for (const imp of imports) {
      if (imp.t === RE_EXPORT_TYPE && imp.n && imp.n.startsWith('.')) {
        for (const ext of RESOLVE_EXTENSIONS) {
          const candidate = path.resolve(dir, imp.n + ext);
          if (!existsSync(candidate) || statSync(candidate).isDirectory()) continue;
          const childNames = getNamedExportsFromSource(candidate, visited);
          for (const n of childNames) names.add(n);
          break;
        }
      }
    }
  } catch {
    // Ignore; keep going and merge regex-based detection below.
  }

  // es-module-lexer cannot parse JSX/TSX or type-only export syntax in some
  // TS packages. Always merge regex-based detection so we still extract exports.
  for (const n of getNamedExportsViaRegex(source)) names.add(n);

  // Regex fallback for `export * from './...'`, since parse() may fail on
  // TS/JSX files and we still need to recurse into those re-export targets.
  const exportStarRegex = /export\s+\*\s+from\s+["'`]([^"'`]+)["'`]/g;
  let match: RegExpExecArray | null;
  while ((match = exportStarRegex.exec(source)) !== null) {
    const importPath = match[1];
    if (!importPath || !importPath.startsWith('.')) continue;
    const dir = path.dirname(resolved);
    for (const ext of RESOLVE_EXTENSIONS) {
      const candidate = path.resolve(dir, importPath + ext);
      if (!existsSync(candidate) || statSync(candidate).isDirectory()) continue;
      for (const n of getNamedExportsFromSource(candidate, visited)) names.add(n);
      break;
    }
  }

  // es-module-lexer currently misses some export surfaces for mixed TS/JS
  // workspace packages, especially with type-only/indirection patterns.
  if (names.size === 0) {
    const parsedPath = path.parse(resolved);
    const basePath = path.join(parsedPath.dir, parsedPath.name);
    const currentExt = parsedPath.ext;

    for (const fallbackExt of SOURCE_FALLBACK_EXTENSIONS) {
      if (fallbackExt === currentExt) continue;

      const fallbackPath = `${basePath}${fallbackExt}`;
      if (!existsSync(fallbackPath)) continue;
      if (fallbackPath === resolved || visited.has(fallbackPath)) continue;

      const fallbackNames = getNamedExportsFromSource(fallbackPath, visited);
      for (const name of fallbackNames) {
        names.add(name);
      }

      if (names.size > 0) {
        break;
      }
    }
  }

  return Array.from(names);
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
    // require() fails for ESM-only / workspace packages — parse the entry source
    const entryPath = getPackageEsmEntryPath(pkg) || resolvePackageEntryFromProjectRoot(pkg);
    if (!entryPath) return [];
    return getNamedExportsFromSource(entryPath);
  }
}

export function getLocalProviderImportPath(pkg: string): string | undefined {
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

// *** __prebuild__
const preBuildCacheMap: Record<string, VirtualModule> = {};
const preBuildShareItemMap: Record<string, ShareItem | undefined> = {};
export const PREBUILD_TAG = '__prebuild__';
export function writePreBuildLibPath(pkg: string, shareItem?: ShareItem) {
  if (!preBuildCacheMap[pkg]) preBuildCacheMap[pkg] = new VirtualModule(pkg, PREBUILD_TAG);
  preBuildShareItemMap[pkg] = shareItem;
  preBuildCacheMap[pkg].writeSync('', true);
}
export function getPreBuildLibImportId(pkg: string): string {
  if (!preBuildCacheMap[pkg]) preBuildCacheMap[pkg] = new VirtualModule(pkg, PREBUILD_TAG);
  const importId = preBuildCacheMap[pkg].getImportId();
  return importId;
}
export function getPreBuildShareItem(pkg: string): ShareItem | undefined {
  return preBuildShareItemMap[pkg];
}

export function getSharedImportSource(pkg: string, shareItem?: ShareItem): string {
  return getConcreteSharedImportSource(pkg, shareItem) || getPreBuildLibImportId(pkg);
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

  // import: false means the host must provide this module — the remote has no local copy.
  // Generate a minimal loadShare module that just delegates to the runtime.
  // No prebuild imports, no dev warming imports.
  if (shareItem.shareConfig.import === false) {
    // For ESM builds, try to detect named exports from locally installed devDependencies.
    // This enables `import { ref } from 'vue'` even though the module is provided by the host.
    // For packages that aren't installed, fall back to default-only export (CJS interop
    // in dev mode, default export in build mode).
    const namedExports = useESM ? getPackageNamedExports(pkg) : [];
    let exportLine: string;
    if (useESM && namedExports.length > 0) {
      const destructure = `const { ${namedExports.map((name, i) => `${name}: __mf_${i}`).join(', ')} } = exportModule;`;
      const namedExportLine = `export { ${namedExports.map((name, i) => `__mf_${i} as ${name}`).join(', ')} };`;
      exportLine = `export default exportModule.default ?? exportModule;\n    ${destructure}\n    ${namedExportLine}`;
    } else {
      if (useESM) {
        mfWarn(
          `Shared dependency "${pkg}" has import: false but is not installed locally.\n` +
            `  Named imports (e.g. import { ... } from '${pkg}') will not work in production builds.\n` +
            `  Install it as a devDependency to enable named export detection.`
        );
      }
      exportLine = useESM
        ? 'export default exportModule.default ?? exportModule'
        : 'module.exports = exportModule';
    }
    loadShareCacheMap[pkg].writeSync(
      `
    ${importLine}
    const res = initPromise.then(runtime => runtime.loadShare(${escapeGeneratedStringLiteral(pkg)}, {
      customShareInfo: {shareConfig:{
        singleton: ${shareItem.shareConfig.singleton},
        strictVersion: ${shareItem.shareConfig.strictVersion},
        requiredVersion: ${JSON.stringify(shareItem.shareConfig.requiredVersion)}
      }}
    }))
    const exportModule = ${awaitOrPlaceholder}res.then((factory) => (typeof factory === "function" ? factory() : factory))
    ${exportLine}
  `,
      true
    );
    return;
  }

  // Normal path: package is installed locally, create full loadShare with prebuild fallback.
  const isVinext = hasPackageDependency('vinext');
  const useSsrProviderFallback = isVinext && command === 'build' && pkg === 'react';
  const concreteSharedImportSource = getConcreteSharedImportSource(pkg, shareItem);
  const sharedImportSource = concreteSharedImportSource || getPreBuildLibImportId(pkg);
  const devImportSource = concreteSharedImportSource || pkg;
  const localProviderPath = getLocalProviderImportPath(pkg);
  const isWorkspacePackage = localProviderPath !== undefined;
  const providerImportId = localProviderPath || concreteSharedImportSource || sharedImportSource;
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

  // For workspace/linked packages, skip the eager __prebuild__ import and the
  // dev-mode dynamic import.  These side-effect imports would load a second
  // copy of the module, creating duplicate module instances even though
  // loadShare returns the host's singleton.
  const prebuildImportLine = isWorkspacePackage
    ? ''
    : `import ${escapeGeneratedStringLiteral(sharedImportSource)};`;
  const devDynamicImportLine = isWorkspacePackage
    ? ''
    : command !== 'build'
      ? `;() => import(${escapeGeneratedStringLiteral(devImportSource)}).catch(() => {});`
      : '';

  loadShareCacheMap[pkg].writeSync(
    `
    ${prebuildImportLine}
    ${devDynamicImportLine}
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

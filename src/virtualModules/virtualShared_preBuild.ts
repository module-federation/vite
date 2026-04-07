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

function isValidJsIdentifier(name: string): boolean {
  return /^[$_\p{ID_Start}][$_\u200C\u200D\p{ID_Continue}]*$/u.test(name);
}

function isValidEsmExportName(name: string | undefined): name is string {
  return !!name && name !== 'default' && name !== '__esModule' && isValidJsIdentifier(name);
}

const JS_IDENTIFIER_START = '[$_\\p{ID_Start}]';
const JS_IDENTIFIER_CONTINUE = '[$_\\u200C\\u200D\\p{ID_Continue}]';
const JS_IDENTIFIER_PATTERN = `${JS_IDENTIFIER_START}${JS_IDENTIFIER_CONTINUE}*`;

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
        const packageJsonContent = readFileSync(packageJsonPath, 'utf-8');
        try {
          const packageJson = JSON.parse(packageJsonContent) as { name?: string };
          if (packageJson.name === packageName) return packageJsonPath;
        } catch (error) {
          // Skip malformed package.json and continue searching up the tree
          if (!(error instanceof SyntaxError)) throw error;
        }
      }
      currentDir = path.dirname(currentDir);
    }

    const rootPackageJsonPath = path.join(rootDir, 'package.json');
    if (existsSync(rootPackageJsonPath)) {
      const rootPackageJsonContent = readFileSync(rootPackageJsonPath, 'utf-8');
      try {
        const packageJson = JSON.parse(rootPackageJsonContent) as { name?: string };
        if (packageJson.name === packageName) return rootPackageJsonPath;
      } catch (error) {
        // Skip malformed root package.json
        if (!(error instanceof SyntaxError)) throw error;
      }
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
  let source = '';
  let entryPath: string | undefined;
  try {
    entryPath = getPackageEsmEntryPath(pkg);
    if (!entryPath) return [];

    const { initSync, parse } = localRequire('es-module-lexer') as typeof import('es-module-lexer');
    initSync();
    source = readFileSync(entryPath, 'utf-8');
    const [, exports] = parse(source, entryPath);

    const names = exports
      .map((item) => item.n)
      .filter((name): name is string => isValidEsmExportName(name));
    const regexNames = getNamedExportsViaRegex(source, entryPath);
    const filteredNames = names.filter((name) => name !== 'type' || regexNames.includes(name));

    if (filteredNames.length > 0) return [...new Set([...filteredNames, ...regexNames])];

    return regexNames;
  } catch {
    return source ? getNamedExportsViaRegex(source, entryPath) : [];
  }
}

function resolveRelativeModule(filePath: string, specifier: string): string | undefined {
  const dir = path.dirname(filePath);
  // Try the specifier as-is first (handles explicit extensions like './runtime.js')
  const exact = path.resolve(dir, specifier);
  if (existsSync(exact) && !statSync(exact).isDirectory()) return exact;
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts'];
  for (const ext of extensions) {
    const candidate = path.resolve(dir, specifier + ext);
    if (existsSync(candidate) && !statSync(candidate).isDirectory()) return candidate;
  }
  // try index files (for directory imports like './search' -> './search/index.ts')
  const resolved = path.resolve(dir, specifier);
  for (const ext of extensions) {
    const candidate = path.join(resolved, 'index' + ext);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function getNamedExportsViaRegex(
  source: string,
  filePath?: string,
  visited?: Set<string>
): string[] {
  const names = new Set<string>();
  visited = visited || new Set();
  if (filePath) visited.add(filePath);

  const declRegex = new RegExp(
    `export\\s+(?:async\\s+)?(?:` +
      `function(?:\\*\\s*|\\s+\\*?\\s*)` +
      `|const\\s+|let\\s+|var\\s+|class\\s+)(${JS_IDENTIFIER_PATTERN})`,
    'gu'
  );
  let match: RegExpExecArray | null;
  while ((match = declRegex.exec(source)) !== null) {
    const name = match[1];
    if (isValidEsmExportName(name)) names.add(name);
  }

  const listRegex = /export\s*\{([^}]+)\}/g;
  const typeOnlySpecifierRegex = new RegExp(
    `^type\\s+${JS_IDENTIFIER_PATTERN}(?:\\s+as\\s+${JS_IDENTIFIER_PATTERN})?$`,
    'u'
  );
  const exportSpecifierRegex = new RegExp(`(?:\\S+\\s+as\\s+)?(${JS_IDENTIFIER_PATTERN})$`, 'u');
  while ((match = listRegex.exec(source)) !== null) {
    const specifiers = match[1].split(',');
    for (const specifier of specifiers) {
      const trimmed = specifier.trim();
      if (typeOnlySpecifierRegex.test(trimmed)) {
        continue;
      }
      const asMatch = trimmed.match(exportSpecifierRegex);
      if (!asMatch) continue;
      const name = asMatch[1];
      if (isValidEsmExportName(name)) names.add(name);
    }
  }

  // Handle `export * from './module'` re-exports
  if (filePath) {
    const starExportRegex = /export\s+\*\s+from\s+['"]([^'"]+)['"]/g;
    while ((match = starExportRegex.exec(source)) !== null) {
      const specifier = match[1];
      // Only resolve relative imports (starting with . or ..)
      if (!specifier.startsWith('.')) continue;
      const resolvedPath = resolveRelativeModule(filePath, specifier);
      if (!resolvedPath || visited.has(resolvedPath)) continue;
      try {
        const reExportSource = readFileSync(resolvedPath, 'utf-8');
        const reExportNames = getNamedExportsViaRegex(reExportSource, resolvedPath, visited);
        for (const name of reExportNames) {
          names.add(name);
        }
      } catch {
        // skip unreadable files
      }
    }
  }

  return [...names];
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
    return Object.keys(mod).filter((k) => isValidEsmExportName(k));
  } catch {
    return getEsmNamedExports(pkg);
  }
}

export function getLocalProviderImportPath(pkg: string): string | undefined {
  try {
    const projectRequire = createRequire(
      new URL(`file://${path.join(getPackageDetectionCwd(), 'package.json')}`)
    );
    const resolved = projectRequire.resolve(pkg);
    return isWorkspaceFilePath(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function isWorkspaceFilePath(resolved: string | undefined): resolved is string {
  return (
    !!resolved && !resolved.includes('/node_modules/') && !resolved.includes('\\node_modules\\')
  );
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
    const useESM = isRolldown || command === 'build' || command === 'serve';
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
    const useESM = isRolldown || command === 'build' || command === 'serve';
    const ext = useESM ? '.mjs' : '.js';
    loadShareCacheMap[pkg] = new VirtualModule(pkg, LOAD_SHARE_TAG, ext);
  }

  const useESM = command === 'build' || isRolldown || command === 'serve';
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
  const isAstro = hasPackageDependency('astro');
  const useSsrProviderFallback =
    ((isVinext || isAstro) && command === 'build' && pkg === 'react') || command === 'serve';
  const concreteSharedImportSource = getConcreteSharedImportSource(pkg, shareItem);
  const sharedImportSource = concreteSharedImportSource || getPreBuildLibImportId(pkg);
  const devImportSource = concreteSharedImportSource || pkg;
  const localProviderPath = getLocalProviderImportPath(pkg);
  const isWorkspacePackage =
    isWorkspaceFilePath(localProviderPath) || isWorkspaceFilePath(concreteSharedImportSource);
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

  const prebuildImportLine =
    isWorkspacePackage && command !== 'build'
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

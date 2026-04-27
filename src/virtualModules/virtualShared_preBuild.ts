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
  getInstalledPackageEntry,
  getInstalledPackageJson,
  getPackageDetectionCwd,
  getPackageName,
} from '../utils/packageUtils';
import VirtualModule from '../utils/VirtualModule';
import { getRuntimeModuleCacheBootstrapCode } from './virtualRuntimeInitStatus';

const JS_IDENTIFIER_REGEX = new RegExp(
  '^[$_\\p{ID_Start}][$_\\u200C\\u200D\\p{ID_Continue}]*$',
  'u'
);

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
  return JS_IDENTIFIER_REGEX.test(name);
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

function getPackageEsmEntryPath(pkg: string): string | undefined {
  return (
    getInstalledPackageEntry(pkg, {
      conditions: ['browser', 'import', 'module', 'default'],
      resolveSubpathWithRequire: false,
    }) || resolvePackageEntryFromProjectRoot(pkg)
  );
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

    if (filteredNames.length > 0) {
      return Array.from(new Set([...filteredNames, ...regexNames]));
    }

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

export function getProjectResolvedImportPath(pkg: string): string | undefined {
  if (pkg === getPackageName(pkg)) {
    const esmEntry = getPackageEsmEntryPath(pkg);
    if (esmEntry) return esmEntry;
  }

  try {
    const projectRequire = createRequire(
      new URL(`file://${path.join(getPackageDetectionCwd(), 'package.json')}`)
    );
    return projectRequire.resolve(pkg);
  } catch {
    return undefined;
  }
}

function isWorkspaceFilePath(resolved: string | undefined): resolved is string {
  return (
    !!resolved && !resolved.includes('/node_modules/') && !resolved.includes('\\node_modules\\')
  );
}

function isWorkspacePackageEntry(pkg: string, resolved: string | undefined): resolved is string {
  if (!resolved || !path.isAbsolute(resolved) || !isWorkspaceFilePath(resolved)) return false;
  return !!getInstalledPackageJson(pkg, {
    packageName: getPackageName(pkg),
    fromResolvedEntry: resolved,
  });
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
  if (!preBuildCacheMap[pkg]) preBuildCacheMap[pkg] = new VirtualModule(pkg, PREBUILD_TAG, '.js');
  preBuildShareItemMap[pkg] = shareItem;
  const importSource = getConcreteSharedImportSource(pkg, shareItem) || pkg;
  if (pkg === 'react/jsx-dev-runtime') {
    preBuildCacheMap[pkg].writeSync(
      `
    import __mfPrebuildDefault from ${escapeGeneratedStringLiteral(importSource)};
    import * as __mfPrebuildNamespace from ${escapeGeneratedStringLiteral(importSource)};
    const __mfPrebuildExports = __mfPrebuildDefault ?? __mfPrebuildNamespace;
    export const Fragment = __mfPrebuildExports.Fragment;
    export const jsxDEV = __mfPrebuildExports.jsxDEV;
    export default __mfPrebuildExports;
  `,
      true
    );
    return;
  }
  if (pkg === 'react/jsx-runtime') {
    preBuildCacheMap[pkg].writeSync(
      `
    import __mfPrebuildDefault from ${escapeGeneratedStringLiteral(importSource)};
    import * as __mfPrebuildNamespace from ${escapeGeneratedStringLiteral(importSource)};
    const __mfPrebuildExports = __mfPrebuildDefault ?? __mfPrebuildNamespace;
    export const Fragment = __mfPrebuildExports.Fragment;
    export const jsx = __mfPrebuildExports.jsx;
    export const jsxs = __mfPrebuildExports.jsxs;
    export default __mfPrebuildExports;
  `,
      true
    );
    return;
  }
  preBuildCacheMap[pkg].writeSync(
    `
    import * as __mfPrebuildExports from ${escapeGeneratedStringLiteral(importSource)};
    export * from ${escapeGeneratedStringLiteral(importSource)};
    export default __mfPrebuildExports.default ?? __mfPrebuildExports;
  `,
    true
  );
}
export function getPreBuildLibImportId(pkg: string): string {
  if (!preBuildCacheMap[pkg]) preBuildCacheMap[pkg] = new VirtualModule(pkg, PREBUILD_TAG, '.js');
  const importId = preBuildCacheMap[pkg].getImportId();
  return importId;
}
export function getPreBuildLibPath(pkg: string): string {
  if (!preBuildCacheMap[pkg]) preBuildCacheMap[pkg] = new VirtualModule(pkg, PREBUILD_TAG, '.js');
  return preBuildCacheMap[pkg].getPath();
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
export function getLoadShareImportId(pkg: string, _isRolldown: boolean): string {
  if (!loadShareCacheMap[pkg]) {
    loadShareCacheMap[pkg] = new VirtualModule(pkg, LOAD_SHARE_TAG, '.mjs');
  }
  return loadShareCacheMap[pkg].getImportId();
}
export function getLoadShareModulePath(pkg: string, isRolldown: boolean): string {
  if (!loadShareCacheMap[pkg]) getLoadShareImportId(pkg, isRolldown);
  const filepath = loadShareCacheMap[pkg].getPath();
  return filepath;
}
export function writeLoadShareModule(
  pkg: string,
  shareItem: ShareItem,
  command: string,
  _isRolldown: boolean
) {
  if (!loadShareCacheMap[pkg]) {
    loadShareCacheMap[pkg] = new VirtualModule(pkg, LOAD_SHARE_TAG, '.mjs');
  }
  const importLine = getRuntimeModuleCacheBootstrapCode();

  // import: false means the host must provide this module — the remote has no local copy.
  // Generate a minimal loadShare module that just delegates to the runtime.
  // No prebuild imports, no dev warming imports.
  if (shareItem.shareConfig.import === false) {
    // Try to detect named exports from locally installed devDependencies.
    // This enables `import { ref } from 'vue'` even though the module is provided by the host.
    // For packages that aren't installed, fall back to default-only export.
    const namedExports = getPackageNamedExports(pkg);
    let exportLine: string;
    if (namedExports.length > 0) {
      const destructure = `const { ${namedExports.map((name, i) => `${name}: __mf_${i}`).join(', ')} } = exportModule;`;
      const namedExportLine = `export { ${namedExports.map((name, i) => `__mf_${i} as ${name}`).join(', ')} };`;
      exportLine = `export default exportModule.default ?? exportModule;\n    ${destructure}\n    ${namedExportLine}`;
    } else {
      mfWarn(
        `Shared dependency "${pkg}" has import: false but is not installed locally.\n` +
          `  Named imports (e.g. import { ... } from '${pkg}') will not work in production builds.\n` +
          `  Install it as a devDependency to enable named export detection.`
      );
      exportLine = 'export default exportModule.default ?? exportModule';
    }
    loadShareCacheMap[pkg].writeSync(
      `
    ${importLine}
    const exportModule = __mfModuleCache.share[${escapeGeneratedStringLiteral(pkg)}]
    if (exportModule === undefined) {
      throw new Error("[Module Federation] Shared module ${pkg} was imported before federation bootstrap finished.")
    }
    ${exportLine}
  `,
      true
    );
    return;
  }

  // Normal path: package is installed locally, create full loadShare with prebuild fallback.
  const concreteSharedImportSource = getConcreteSharedImportSource(pkg, shareItem);
  const sharedImportSource = concreteSharedImportSource || getPreBuildLibImportId(pkg);
  const devImportSource = concreteSharedImportSource || pkg;
  const localProviderPath = getLocalProviderImportPath(pkg);
  const isWorkspacePackage =
    isWorkspacePackageEntry(pkg, localProviderPath) ||
    isWorkspacePackageEntry(pkg, concreteSharedImportSource);
  const lazyLocalFallbackSource =
    concreteSharedImportSource || localProviderPath || sharedImportSource;
  const skipServePrebuildWarmup = command !== 'build' && (pkg === 'lit' || pkg.startsWith('lit/'));
  const namedExports = getPackageNamedExports(pkg);
  let exportLine: string;
  if (namedExports.length > 0) {
    const destructure = `const { ${namedExports.map((name, i) => `${name}: __mf_${i}`).join(', ')} } = exportModule;`;
    const namedExportLine = `export { ${namedExports.map((name, i) => `__mf_${i} as ${name}`).join(', ')} };`;
    exportLine = `export default exportModule.default ?? exportModule;\n    ${destructure}\n    ${namedExportLine}`;
  } else {
    exportLine = `export default exportModule.default ?? exportModule\n    export * from ${escapeGeneratedStringLiteral(sharedImportSource)}`;
  }

  const usesLazyLocalFallback = isWorkspacePackage && shareItem.shareConfig.singleton === true;
  const staticLocalShareSource = skipServePrebuildWarmup ? devImportSource : sharedImportSource;
  const prebuildImportLine =
    usesLazyLocalFallback || (isWorkspacePackage && command !== 'build')
      ? ''
      : `import * as __mfLocalShare from ${escapeGeneratedStringLiteral(staticLocalShareSource)};`;
  const devDynamicImportLine = isWorkspacePackage
    ? ''
    : command !== 'build' && !skipServePrebuildWarmup
      ? `;() => import(${escapeGeneratedStringLiteral(devImportSource)}).catch(() => {});`
      : '';

  loadShareCacheMap[pkg].writeSync(
    `
    ${prebuildImportLine}
    ${devDynamicImportLine}
    ${importLine}
    let exportModule = __mfModuleCache.share[${escapeGeneratedStringLiteral(pkg)}]
    if (exportModule === undefined) {
      ${
        usesLazyLocalFallback
          ? `exportModule = await import(${escapeGeneratedStringLiteral(lazyLocalFallbackSource)});
      __mfModuleCache.share[${escapeGeneratedStringLiteral(pkg)}] = exportModule;`
          : `exportModule = __mfLocalShare;
      __mfModuleCache.share[${escapeGeneratedStringLiteral(pkg)}] = exportModule;`
      }
    }
    ${exportLine}
  `,
    true
  );
}

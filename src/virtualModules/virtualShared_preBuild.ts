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

import { existsSync, readFileSync, realpathSync, statSync } from 'fs';
import { createRequire } from 'module';
import * as path from 'node:path';
import { pathToFileURL } from 'url';
import { mfWarn } from '../utils/logger';
import {
  getNormalizeModuleFederationOptions,
  type NormalizedShared,
  type ShareItem,
} from '../utils/normalizeModuleFederationOptions';
import {
  getInstalledPackageEntry,
  getInstalledPackageJson,
  getPackageDetectionCwd,
  getPackageName,
  packageNameDecode,
  getSharedCacheKey,
} from '../utils/packageUtils';
import VirtualModule, { normalizeVirtualModuleId, toViteEncodedId } from '../utils/VirtualModule';
import {
  getRuntimeInitPromiseBootstrapCode,
  getRuntimeModuleCacheBootstrapCode,
} from './virtualRuntimeInitStatus';

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

function resolvePackageEntryFromProjectRoot(pkg: string): string | undefined {
  try {
    const projectRequire = createRequire(
      pathToFileURL(path.join(getPackageDetectionCwd(), 'package.json'))
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

function getEsmNamedExportsFromFile(entryPath: string | undefined): string[] {
  try {
    if (!entryPath) return [];
    return getNamedExportsViaRegex(readFileSync(entryPath, 'utf-8'), entryPath);
  } catch {
    return [];
  }
}

function getEsmNamedExports(pkg: string): string[] {
  return getEsmNamedExportsFromFile(getPackageEsmEntryPath(pkg));
}

function resolveConfiguredImportPath(importSource: string): string | undefined {
  if (path.isAbsolute(importSource)) {
    return resolveFileLikeModule(importSource);
  }

  const projectRoot = getPackageDetectionCwd();
  if (importSource.startsWith('.')) {
    return resolveFileLikeModule(path.resolve(projectRoot, importSource));
  }

  const esmEntry = getInstalledPackageEntry(importSource, {
    conditions: ['browser', 'import', 'module', 'default'],
    resolveSubpathWithRequire: false,
  });
  if (esmEntry) return esmEntry;

  try {
    const projectRequire = createRequire(pathToFileURL(path.join(projectRoot, 'package.json')));
    return projectRequire.resolve(importSource);
  } catch {
    return undefined;
  }
}

function resolveFileLikeModule(filePath: string): string | undefined {
  if (existsSync(filePath) && !statSync(filePath).isDirectory()) return filePath;

  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts'];
  for (const ext of extensions) {
    const candidate = filePath + ext;
    if (existsSync(candidate) && !statSync(candidate).isDirectory()) return candidate;
  }

  for (const ext of extensions) {
    const candidate = path.join(filePath, 'index' + ext);
    if (existsSync(candidate) && !statSync(candidate).isDirectory()) return candidate;
  }

  return undefined;
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
      `|const\\s+|let\\s+|var\\s+|class\\s+|enum\\s+|namespace\\s+)(${JS_IDENTIFIER_PATTERN})`,
    'gu'
  );
  let match: RegExpExecArray | null;
  while ((match = declRegex.exec(source)) !== null) {
    const name = match[1];
    if (isValidEsmExportName(name)) names.add(name);
  }

  // Destructuring exports, e.g. `export const { a, b: alias, ...rest } = obj;`
  // or `export const [first, ...others] = arr;` — the shape Redux Toolkit's
  // `createSlice` produces (`export const { addItem: createActionAddItem } = slice.actions`).
  // These are matched by neither `declRegex` (the next token is `{`/`[`) nor the
  // `export { ... }` list regex below (the leading `const` breaks it).
  const destructureRegex = /export\s+(?:const|let|var)\s+(\{[^}]*\}|\[[^\]]*\])\s*=/g;
  const bindingNameRegex = new RegExp(`^(${JS_IDENTIFIER_PATTERN})`, 'u');
  while ((match = destructureRegex.exec(source)) !== null) {
    const inner = match[1].slice(1, -1);
    for (const part of inner.split(',')) {
      // strip a default value (`= ...`); rest elements (`...x`) never have one
      let token = part.split('=')[0].trim();
      // rest element `...rest` -> the bound name is `rest`
      if (token.startsWith('...')) token = token.slice(3).trim();
      if (!token) continue;
      // object rename `key: alias` -> the bound name is the alias
      if (token.includes(':')) token = token.slice(token.indexOf(':') + 1).trim();
      const bindingMatch = token.match(bindingNameRegex);
      if (bindingMatch && isValidEsmExportName(bindingMatch[1])) names.add(bindingMatch[1]);
    }
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

  const namespaceReExportRegex = new RegExp(
    `export\\s+\\*\\s+as\\s+(${JS_IDENTIFIER_PATTERN})\\s+from\\s+['"][^'"]+['"]`,
    'gu'
  );
  while ((match = namespaceReExportRegex.exec(source)) !== null) {
    if (isValidEsmExportName(match[1])) names.add(match[1]);
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
      pathToFileURL(path.join(getPackageDetectionCwd(), 'package.json'))
    );
    const mod = projectRequire(pkg);
    return Object.keys(mod).filter((k) => isValidEsmExportName(k));
  } catch {
    return getEsmNamedExports(pkg);
  }
}

function getSharedNamedExports(pkg: string, shareItem?: ShareItem): string[] {
  const configuredImport = shareItem?.shareConfig.import;
  if (typeof configuredImport === 'string') {
    const configuredImportPath = resolveConfiguredImportPath(configuredImport);
    const configuredNamedExports = getEsmNamedExportsFromFile(configuredImportPath);
    if (configuredNamedExports.length > 0) return configuredNamedExports;
  }

  return getPackageNamedExports(pkg);
}

export function getLocalProviderImportPath(pkg: string): string | undefined {
  try {
    const projectRequire = createRequire(
      pathToFileURL(path.join(getPackageDetectionCwd(), 'package.json'))
    );
    const resolved = projectRequire.resolve(pkg);
    return isWorkspaceFilePath(resolved) ? resolved : undefined;
  } catch {
    const resolved = getInstalledPackageEntry(pkg, {
      conditions: ['browser', 'import', 'module', 'default'],
      resolveSubpathWithRequire: false,
    });
    return isWorkspaceFilePath(resolved) ? resolved : undefined;
  }
}

export function getProjectResolvedImportPath(pkg: string): string | undefined {
  if (pkg === getPackageName(pkg)) {
    const esmEntry = getPackageEsmEntryPath(pkg);
    if (esmEntry) return esmEntry;
  }

  try {
    const projectRequire = createRequire(
      pathToFileURL(path.join(getPackageDetectionCwd(), 'package.json'))
    );
    return projectRequire.resolve(pkg);
  } catch {
    return undefined;
  }
}

function isWorkspaceFilePath(resolved: string | undefined): resolved is string {
  if (!resolved) return false;
  let realResolved = resolved;
  try {
    realResolved = realpathSync.native(resolved);
  } catch {}
  return !realResolved.includes('/node_modules/') && !realResolved.includes('\\node_modules\\');
}

function isWorkspacePackageEntry(pkg: string, resolved: string | undefined): resolved is string {
  if (!resolved || !path.isAbsolute(resolved) || !isWorkspaceFilePath(resolved)) return false;
  return !!getInstalledPackageJson(pkg, {
    packageName: getPackageName(pkg),
    fromResolvedEntry: resolved,
  });
}

function getWorkspacePackageJson(pkg: string) {
  const resolved = getLocalProviderImportPath(pkg) || getProjectResolvedImportPath(pkg);
  if (!isWorkspacePackageEntry(pkg, resolved)) return;
  return getInstalledPackageJson(pkg, {
    packageName: getPackageName(pkg),
    fromResolvedEntry: resolved,
  })?.packageJson;
}

function getDependencyNames(packageJson: Record<string, unknown> | undefined) {
  if (!packageJson) return [];
  const names = new Set<string>();
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
    const deps = packageJson[field];
    if (!deps || typeof deps !== 'object') continue;
    for (const dep of Object.keys(deps)) names.add(dep);
  }
  return Array.from(names);
}

function isWorkspaceSingletonConsumedByPeer(pkg: string) {
  const options = getNormalizeModuleFederationOptions();
  const shared = options?.shared || {};
  const sharedKeyByPackageName = new Map<string, string>();
  Object.entries(shared)
    .filter(([, item]) => item.shareConfig.singleton === true)
    .forEach(([key]) => {
      const packageName = getPackageName(key);
      const existing = sharedKeyByPackageName.get(packageName);
      if (!existing || key === packageName) {
        sharedKeyByPackageName.set(packageName, key);
      }
    });

  // A workspace singleton must assign its exports synchronously (eager) when a
  // peer shared singleton can read them at module-evaluation time. That happens
  // whenever another shared singleton depends on `pkg`: the bundler may evaluate
  // the consumer before `pkg`'s lazy `loadShare` wrapper has populated the share
  // cache, leaving the consumer's top-level read of `pkg`'s bindings undefined.
  // This covers both cyclic graphs and acyclic ones where a package is shared
  // together with one of its subpath exports (see issue #823).
  const reachesPkg = (current: string, seen: Set<string>): boolean => {
    const packageJson = getWorkspacePackageJson(current);
    for (const dependency of getDependencyNames(packageJson)) {
      const sharedDependency = sharedKeyByPackageName.get(dependency);
      if (!sharedDependency) continue;
      if (sharedDependency === pkg) return true;
      if (seen.has(sharedDependency)) continue;
      seen.add(sharedDependency);
      if (reachesPkg(sharedDependency, seen)) return true;
    }
    return false;
  };

  return Array.from(sharedKeyByPackageName.values()).some(
    (sharedPkg) => sharedPkg !== pkg && reachesPkg(sharedPkg, new Set([sharedPkg]))
  );
}

function tryResolveImportFromPackageRoot(pkg: string, root: string): string | undefined {
  try {
    const projectRequire = createRequire(pathToFileURL(path.join(root, 'package.json')));
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
  if (pkg === 'react/compiler-runtime') {
    preBuildCacheMap[pkg].writeSync(
      `
    const __mfCacheGlobalKey = "__mf_module_cache__";
    export const c = function(size) {
      const cache = globalThis[__mfCacheGlobalKey]?.share;
      const sharedReact = cache?.['react'];
      const reactExports = sharedReact?.default ?? sharedReact;
      const internals = reactExports?.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
      return internals?.H?.useMemoCache(size);
    };
    export default { c };
  `,
      true
    );
    return;
  }
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
  const namedExports = getSharedNamedExports(pkg, shareItem);
  if (namedExports.length > 0) {
    const namedExportVars = namedExports.map((_name, i) => `__mf_${i}`);
    const declarations = namedExports
      .map(
        (name, i) =>
          `const ${namedExportVars[i]} = __mfPrebuildExports[${escapeGeneratedStringLiteral(name)}];`
      )
      .join('\n    ');
    const namedExportLine = `export { ${namedExports.map((name, i) => `${namedExportVars[i]} as ${name}`).join(', ')} };`;

    preBuildCacheMap[pkg].writeSync(
      `
    import * as __mfPrebuildNamespace from ${escapeGeneratedStringLiteral(importSource)};
    const __mfPrebuildExports = __mfPrebuildNamespace;
    ${declarations}
    ${namedExportLine}
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
  return preBuildCacheMap[pkg].getImportId();
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
    loadShareCacheMap[pkg] = new VirtualModule(pkg, LOAD_SHARE_TAG, '.js');
  }
  return loadShareCacheMap[pkg].getImportId();
}
export function getLoadShareModulePath(pkg: string, isRolldown: boolean): string {
  if (!loadShareCacheMap[pkg]) getLoadShareImportId(pkg, isRolldown);
  const filepath = loadShareCacheMap[pkg].getImportId();
  return filepath;
}

export function toViteOptimizedDepVirtualId(id: string): string {
  return toViteEncodedId(id);
}

export function getCachedLoadSharePkg(id: string): string | undefined {
  // Most resolved ids are not loadShare virtual ids. Fast reject before
  // normalization/decoding work on the resolveId hot path.
  if (!id.includes(LOAD_SHARE_TAG)) return;
  const normalized = normalizeVirtualModuleId(id);
  if (!normalized.startsWith('virtual:mf:')) return;

  const start = normalized.indexOf(LOAD_SHARE_TAG);
  if (start === -1) return;

  const encodedPkgStart = start + LOAD_SHARE_TAG.length;
  const end = normalized.indexOf(LOAD_SHARE_TAG, encodedPkgStart);
  if (end === -1) return;

  return packageNameDecode(normalized.slice(encodedPkgStart, end));
}

export function materializeCachedLoadShareModule(options: {
  id: string;
  shared: NormalizedShared;
  command: string;
  isRolldown: boolean;
  findSharedKey: (source: string, shared: NormalizedShared) => string | undefined;
  addUsedShares: (pkg: string) => void;
  writeLocalSharedImportMap: () => void;
}): void {
  const pkg = getCachedLoadSharePkg(options.id);
  if (!pkg) return;
  const key = options.findSharedKey(pkg, options.shared);
  if (!key) return;

  const shareItem = options.shared[key];
  writeLoadShareModule(pkg, shareItem, options.command, options.isRolldown);
  if (shareItem.shareConfig?.import !== false) {
    writePreBuildLibPath(pkg, shareItem);
  }
  options.addUsedShares(pkg);
  options.writeLocalSharedImportMap();
}

function generateEagerWorkspaceSingletonExports(
  namedExports: string[],
  importSource: string,
  cacheKey: string
) {
  const namedExportLine =
    namedExports.length > 0
      ? `\n    export { ${namedExports.join(', ')} } from ${escapeGeneratedStringLiteral(importSource)};`
      : '';

  return `import * as __mfLocalShare from ${escapeGeneratedStringLiteral(importSource)};
    let exportModule = __mfModuleCache.share[${escapeGeneratedStringLiteral(cacheKey)}];
    if (exportModule === undefined) {
      Promise.resolve().then(() => {
        if (__mfModuleCache.share[${escapeGeneratedStringLiteral(cacheKey)}] === undefined) {
          __mfModuleCache.share[${escapeGeneratedStringLiteral(cacheKey)}] = __mfNormalizeShareModule(__mfLocalShare);
        }
      });
      exportModule = __mfLocalShare;
    }
    const __mf_default = exportModule.default ?? exportModule;
    export { __mf_default as default };${namedExportLine}`;
}

function generateLazyWorkspaceSingletonExports(
  namedExports: string[],
  importSource: string,
  cacheKey: string,
  eagerLocalFallback: boolean
) {
  const namedExportVars = namedExports.map((_name, i) => `__mf_${i}`);
  const declarations =
    namedExports.length > 0
      ? ['let __mf_default;', ...namedExportVars.map((name) => `let ${name};`)].join('\n    ')
      : 'let __mf_default;';
  const assignments =
    namedExports.length > 0
      ? [
          ...namedExports.map(
            (name, i) => `${namedExportVars[i]} = mod[${escapeGeneratedStringLiteral(name)}];`
          ),
          '__mf_default = mod.default ?? mod;',
        ].join('\n      ')
      : '__mf_default = mod.default ?? mod;';
  const namedExportLine =
    namedExports.length > 0
      ? `\n    export { ${namedExports.map((name, i) => `${namedExportVars[i]} as ${name}`).join(', ')} };`
      : '';
  const applyLocalFallback = `exportModule = __mfNormalizeShareModule(__mfLocalShare);
      __mfModuleCache.share[${escapeGeneratedStringLiteral(cacheKey)}] = exportModule;
      __mfApplyLazyShareExports(exportModule);`;

  const asyncLoadCode = `initPromise.then(() =>
        import(${escapeGeneratedStringLiteral(importSource)}).then((mod) => {
          exportModule = __mfNormalizeShareModule(mod);
          __mfModuleCache.share[${escapeGeneratedStringLiteral(cacheKey)}] = exportModule;
          __mfApplyLazyShareExports(exportModule);
        })
      )`;

  const body = `${declarations}
    const __mfApplyLazyShareExports = (mod) => {
      ${assignments}
    };
    let exportModule = __mfModuleCache.share[${escapeGeneratedStringLiteral(cacheKey)}];
    if (exportModule === undefined) {
      ${
        eagerLocalFallback
          ? applyLocalFallback
          : `if (import.meta.env.SSR) {
        ${applyLocalFallback}
      } else {
        (__mfModuleCache.pendingShareLoads ||= []).push(${asyncLoadCode});
      }`
      }
    } else {
      (__mfModuleCache.pendingShareLoads ||= []).push(${asyncLoadCode});
    }
    export { __mf_default as default };${namedExportLine}`;

  // Serve mode eagerly binds the local fallback. Build mode omits the static
  // import here so client chunks never evaluate workspace singleton side effects
  // before federation init; the SSR build prepends it in the load hook instead.
  return eagerLocalFallback
    ? `import * as __mfLocalShare from ${escapeGeneratedStringLiteral(importSource)};
    ${body}`
    : body;
}

const WORKSPACE_SINGLETON_SSR_LOCAL_SHARE = '__mfNormalizeShareModule(__mfLocalShare)';

export function prependWorkspaceSingletonSsrImport(code: string): string {
  if (!code.includes('if (import.meta.env.SSR)')) return code;
  if (!code.includes(WORKSPACE_SINGLETON_SSR_LOCAL_SHARE)) return code;
  if (code.includes('import * as __mfLocalShare')) return code;

  const importMatch = code.match(
    /initPromise\.then\(\(\)\s*=>\s*\n\s*import\((["'])(.+?)\1\)\.then\(\(mod\)\s*=>\s*\{[\s\S]*?__mfApplyLazyShareExports/
  );
  if (!importMatch) return code;

  const quote = importMatch[1];
  const importSource = importMatch[2];
  return `import * as __mfLocalShare from ${quote}${importSource}${quote};\n${code}`;
}

function generateDeferredHostProvidedExports(
  namedExports: string[],
  pkg: string,
  cacheKey: string
) {
  const namedExportVars = namedExports.map((_name, i) => `__mf_${i}`);
  const declarations = ['let __mf_default;', ...namedExportVars.map((name) => `let ${name};`)].join(
    '\n    '
  );
  const assignments = [
    ...namedExports.map(
      (name, i) => `${namedExportVars[i]} = exportModule[${escapeGeneratedStringLiteral(name)}];`
    ),
    '__mf_default = exportModule.default ?? exportModule;',
  ].join('\n      ');
  const namedExportLine =
    namedExports.length > 0
      ? `\n    export { ${namedExports.map((name, i) => `${namedExportVars[i]} as ${name}`).join(', ')} };`
      : '';

  return `${declarations}
    const __mfApplyHostProvidedExports = (exportModule) => {
      ${assignments}
    };
    let exportModule = __mfModuleCache.share[${escapeGeneratedStringLiteral(cacheKey)}];
    if (exportModule === undefined) {
      initPromise.then(() => {
        exportModule = __mfModuleCache.share[${escapeGeneratedStringLiteral(cacheKey)}];
        if (exportModule === undefined) {
          throw new Error("[Module Federation] Shared module ${pkg} was imported before federation bootstrap finished.");
        }
        __mfApplyHostProvidedExports(exportModule);
      });
    } else {
      (__mfModuleCache.pendingShareLoads ||= []).push(
        initPromise.then(() => {
          exportModule = __mfModuleCache.share[${escapeGeneratedStringLiteral(cacheKey)}];
          __mfApplyHostProvidedExports(exportModule);
        })
      );
    }
    export { __mf_default as default };${namedExportLine}`;
}

function generateShareModuleUnwrapCode({
  source,
  preserveNamedExports,
  stopWithReturn,
}: {
  source: string;
  preserveNamedExports: boolean;
  stopWithReturn?: string;
}) {
  const stopLine = stopWithReturn
    ? `if (!defaultExport || typeof defaultExport !== "object") return ${stopWithReturn};`
    : `if (!defaultExport || typeof defaultExport !== "object") break;`;
  const namedExportGuard = preserveNamedExports
    ? `
        const namedValues = Object.keys(current).filter((key) => key !== "default").map((key) => current[key]);
        if (namedValues.length > 0 && namedValues.some((value) => value !== undefined)) break;`
    : '';

  return `let current = ${source};
      for (let i = 0; i < 5; i++) {
        const defaultExport = current?.default;
        ${stopLine}${namedExportGuard}
        current = defaultExport;
      }
      return current;`;
}

const normalizeLocalShareModuleCode = `const __mfNormalizeShareModule = (mod) => {
      ${generateShareModuleUnwrapCode({ source: 'mod', preserveNamedExports: true })}
    };`;

export function writeLoadShareModule(
  pkg: string,
  shareItem: ShareItem,
  command: string,
  _isRolldown: boolean
) {
  if (!loadShareCacheMap[pkg]) {
    loadShareCacheMap[pkg] = new VirtualModule(pkg, LOAD_SHARE_TAG, '.js');
  }
  let importLine = getRuntimeModuleCacheBootstrapCode();
  const cacheKey = getSharedCacheKey(pkg, shareItem);

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
      exportLine = generateDeferredHostProvidedExports(namedExports, pkg, cacheKey);
    } else {
      mfWarn(
        `Shared dependency "${pkg}" has import: false but is not installed locally.\n` +
          `  Named imports (e.g. import { ... } from '${pkg}') will not work in production builds.\n` +
          `  Install it as a devDependency to enable named export detection.`
      );
      exportLine = generateDeferredHostProvidedExports([], pkg, cacheKey);
    }
    loadShareCacheMap[pkg].writeSync(
      `
    ${getRuntimeInitPromiseBootstrapCode()}
    ${importLine}
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
  const isWorkspaceSingleton = isWorkspacePackage && shareItem.shareConfig.singleton === true;
  const usesEagerWorkspaceFallback =
    isWorkspaceSingleton && isWorkspaceSingletonConsumedByPeer(pkg);
  const namedExports = getSharedNamedExports(pkg, shareItem);
  let exportLine: string;
  let initBlock = '';
  if (usesEagerWorkspaceFallback) {
    exportLine = generateEagerWorkspaceSingletonExports(
      namedExports,
      lazyLocalFallbackSource,
      cacheKey
    );
  } else if (isWorkspaceSingleton) {
    importLine = `${getRuntimeInitPromiseBootstrapCode()}\n    ${importLine}`;
    exportLine = generateLazyWorkspaceSingletonExports(
      namedExports,
      lazyLocalFallbackSource,
      cacheKey,
      command !== 'build'
    );
  } else if (namedExports.length > 0) {
    const destructure = `const { ${namedExports.map((name, i) => `${name}: __mf_${i}`).join(', ')} } = exportModule;`;
    const namedExportLine = `export { ${namedExports.map((name, i) => `__mf_${i} as ${name}`).join(', ')} };`;
    exportLine = `const __mfDefaultExport = (() => {
      ${generateShareModuleUnwrapCode({
        source: 'exportModule',
        preserveNamedExports: false,
        stopWithReturn: 'defaultExport ?? current',
      })}
    })();
    export default __mfDefaultExport;
    ${destructure}
    ${namedExportLine}`;
    initBlock = `exportModule = __mfNormalizeShareModule(__mfLocalShare);
      __mfModuleCache.share[${escapeGeneratedStringLiteral(cacheKey)}] = exportModule;`;
  } else {
    exportLine = `export default exportModule.default ?? exportModule\n    export * from ${escapeGeneratedStringLiteral(sharedImportSource)}`;
    initBlock = `exportModule = __mfNormalizeShareModule(__mfLocalShare);
      __mfModuleCache.share[${escapeGeneratedStringLiteral(cacheKey)}] = exportModule;`;
  }

  const staticLocalShareSource = skipServePrebuildWarmup ? devImportSource : sharedImportSource;
  const prebuildImportLine =
    isWorkspaceSingleton || (isWorkspacePackage && command !== 'build')
      ? ''
      : `import * as __mfLocalShare from ${escapeGeneratedStringLiteral(staticLocalShareSource)};`;
  const devDynamicImportLine = isWorkspacePackage
    ? ''
    : command !== 'build' && !skipServePrebuildWarmup
      ? `;() => import(${escapeGeneratedStringLiteral(devImportSource)}).catch(() => {});`
      : '';

  const moduleBody = isWorkspaceSingleton
    ? `
    ${prebuildImportLine}
    ${devDynamicImportLine}
    ${importLine}
    ${normalizeLocalShareModuleCode}
    ${exportLine}
  `
    : `
    ${prebuildImportLine}
    ${devDynamicImportLine}
    ${importLine}
    ${normalizeLocalShareModuleCode}
    let exportModule = __mfModuleCache.share[${escapeGeneratedStringLiteral(cacheKey)}]
    if (exportModule === undefined) {
      ${initBlock}
    }
    ${exportLine}
  `;

  loadShareCacheMap[pkg].writeSync(moduleBody, true);
}

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
import { createCodePositionMap } from '../utils/codePositionMap';
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
  packageNameEncode,
  packageNameDecode,
  getSharedCacheDescriptor,
  sharedCacheHelperCode,
} from '../utils/packageUtils';
import VirtualModule, { normalizeVirtualModuleId } from '../utils/VirtualModule';
import { normalizeNodeModulePath } from '../utils/pathNormalization';
import {
  getRuntimeInitPromiseBootstrapCode,
  getRuntimeModuleCacheBootstrapCode,
} from './virtualRuntimeInitStatus';
import { getTreeShakingExportUsage } from '../utils/treeShaking';

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

function getSharedCacheDescriptorLiteral(pkg: string, shareItem: ShareItem): string {
  return JSON.stringify(getSharedCacheDescriptor(pkg, shareItem));
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

type SharedExportInspection = {
  namedExports: string[] | undefined;
  commonJs: boolean;
};

type NamedExportScanState = {
  complete: boolean;
};

function hasCodeMatch(source: string, regex: RegExp, codePositions: boolean[]): boolean {
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    if (codePositions[match.index]) return true;
  }
  return false;
}

function hasCommonJsExports(source: string): boolean {
  const codePositions = createCodePositionMap(source);
  return hasCodeMatch(
    source,
    /\bmodule\s*(?:\.exports|\[\s*['"]exports['"]\s*\])|\bexports\s*(?:\.|\[|[,)]|=(?!=|>))/g,
    codePositions
  );
}

function inspectSharedExportsFromFile(
  entryPath: string | undefined
): SharedExportInspection | undefined {
  try {
    if (!entryPath) return undefined;
    const source = readFileSync(entryPath, 'utf-8');
    const scanState: NamedExportScanState = { complete: true };
    const namedExports = getNamedExportsViaRegex(source, entryPath, undefined, scanState);
    const commonJs = hasCommonJsExports(source);
    return {
      // A complete empty ESM scan is a known default-only export surface. Keep
      // unresolved re-exports and CommonJS sources conservative instead.
      namedExports: scanState.complete && !commonJs ? namedExports : undefined,
      commonJs,
    };
  } catch {
    return undefined;
  }
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

function resolveReExportModule(filePath: string, specifier: string): string | undefined {
  if (specifier.startsWith('.')) return resolveRelativeModule(filePath, specifier);

  // Package entry files commonly re-export their public API from another
  // package (for example, Vue re-exports from @vue/runtime-dom). Resolve the
  // re-export with ESM-oriented conditions so we inspect the same file that
  // Vite will load, rather than a CommonJS fallback selected by require.
  const esmEntry = getInstalledPackageEntry(specifier, {
    cwd: path.dirname(filePath),
    conditions: ['browser', 'import', 'module', 'default'],
    resolveSubpathWithRequire: false,
  });
  if (esmEntry) return esmEntry;

  try {
    return resolveFileLikeModule(createRequire(pathToFileURL(filePath)).resolve(specifier));
  } catch {
    return undefined;
  }
}

function hasTopLevelDeclaratorComma(source: string, start: number): boolean {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  let canStartRegex = true;

  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      canStartRegex = false;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      index = source.indexOf('\n', index + 2);
      if (index === -1) return false;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const commentEnd = source.indexOf('*/', index + 2);
      if (commentEnd === -1) return true;
      index = commentEnd + 1;
      continue;
    }
    if (char === '/' && canStartRegex) {
      let regexEscaped = false;
      let inCharacterClass = false;
      let closed = false;
      for (index++; index < source.length; index++) {
        const regexChar = source[index];
        if (regexEscaped) {
          regexEscaped = false;
          continue;
        }
        if (regexChar === '\\') {
          regexEscaped = true;
          continue;
        }
        if (regexChar === '[') {
          inCharacterClass = true;
          continue;
        }
        if (regexChar === ']' && inCharacterClass) {
          inCharacterClass = false;
          continue;
        }
        if (regexChar === '/' && !inCharacterClass) {
          closed = true;
          while (/[$_\p{ID_Continue}]/u.test(source[index + 1] || '')) index++;
          break;
        }
        if (regexChar === '\n' || regexChar === '\r') return true;
      }
      if (!closed) return true;
      canStartRegex = false;
      continue;
    }
    if (char === '/') {
      canStartRegex = true;
      continue;
    }
    if (/[$_\p{ID_Start}]/u.test(char)) {
      const tokenStart = index;
      while (/[$_\u200C\u200D\p{ID_Continue}]/u.test(source[index + 1] || '')) index++;
      const token = source.slice(tokenStart, index + 1);
      canStartRegex =
        /^(?:await|case|delete|in|instanceof|new|return|throw|typeof|void|yield)$/.test(token);
      continue;
    }
    if (/\d/.test(char)) {
      while (/[\w.]/.test(source[index + 1] || '')) index++;
      canStartRegex = false;
      continue;
    }
    if ((char === '+' || char === '-') && source[index + 1] === char) {
      index++;
      continue;
    }
    if (char === '!' && source[index + 1] !== '=') {
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      depth++;
      canStartRegex = true;
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
      canStartRegex = false;
      continue;
    }
    if (depth === 0 && char === ',') return true;
    if (depth === 0 && char === ';') return false;
    if (!/\s/.test(char)) {
      canStartRegex = char !== '.';
    }
  }

  return false;
}

function hasUnsupportedBindingPattern(source: string, start: number): boolean {
  const opening = source[start];
  if (opening !== '{' && opening !== '[') return false;

  let depth = 0;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (char === '"' || char === "'" || char === '`') return true;
    if (char === '(' || char === '/' || (char === ':' && opening === '[')) return true;
    if (char === '{' || char === '[') {
      depth++;
      if (depth > 1) return true;
      continue;
    }
    if (char === '}' || char === ']') {
      depth--;
      if (depth === 0) {
        let next = index + 1;
        while (/\s/.test(source[next] || '')) next++;
        return source[next] !== '=';
      }
    }
  }

  return true;
}

function getNamedExportsViaRegex(
  source: string,
  filePath?: string,
  visited?: Set<string>,
  scanState: NamedExportScanState = { complete: true }
): string[] {
  const names = new Set<string>();
  const codePositions = createCodePositionMap(source);
  const recognizedExportStarts = new Set<number>();
  visited = visited || new Set();
  if (filePath) visited.add(filePath);

  const declRegex = new RegExp(
    `export\\s+(?:async\\s+)?(?:` +
      `function(?:\\*\\s*|\\s+\\*?\\s*)` +
      `|const\\s+enum\\s+|const\\s+|let\\s+|var\\s+|class\\s+|abstract\\s+class\\s+|enum\\s+|namespace\\s+|module\\s+)(${JS_IDENTIFIER_PATTERN})`,
    'gu'
  );
  let match: RegExpExecArray | null;
  while ((match = declRegex.exec(source)) !== null) {
    if (!codePositions[match.index]) continue;
    recognizedExportStarts.add(match.index);
    const name = match[1];
    if (isValidEsmExportName(name)) names.add(name);
  }

  // The declaration matcher above captures only the first binding in
  // `export const a = 1, b = 2`. Until every declarator is represented by a
  // live proxy binding, treat that export surface as incomplete.
  const exportedVariableDeclarationRegex = /export\s+(?:const|let|var)\s+/g;
  while ((match = exportedVariableDeclarationRegex.exec(source)) !== null) {
    if (!codePositions[match.index]) continue;
    if (hasTopLevelDeclaratorComma(source, exportedVariableDeclarationRegex.lastIndex)) {
      scanState.complete = false;
    }
    if (hasUnsupportedBindingPattern(source, exportedVariableDeclarationRegex.lastIndex)) {
      scanState.complete = false;
    }
  }
  if (
    hasCodeMatch(source, /export\s+import\s+/g, codePositions) ||
    hasCodeMatch(source, /export\s*=/g, codePositions)
  ) {
    scanState.complete = false;
  }
  if (hasCodeMatch(source, /export\s+@/g, codePositions)) {
    scanState.complete = false;
  }

  // Destructuring exports, e.g. `export const { a, b: alias, ...rest } = obj;`
  // or `export const [first, ...others] = arr;` — the shape Redux Toolkit's
  // `createSlice` produces (`export const { addItem: createActionAddItem } = slice.actions`).
  // These are matched by neither `declRegex` (the next token is `{`/`[`) nor the
  // `export { ... }` list regex below (the leading `const` breaks it).
  const destructureRegex = /export\s+(?:const|let|var)\s+(\{[^}]*\}|\[[^\]]*\])\s*=/g;
  const bindingNameRegex = new RegExp(`^(${JS_IDENTIFIER_PATTERN})`, 'u');
  while ((match = destructureRegex.exec(source)) !== null) {
    if (!codePositions[match.index]) continue;
    recognizedExportStarts.add(match.index);
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
    if (!codePositions[match.index]) continue;
    recognizedExportStarts.add(match.index);
    const specifiers = match[1].split(',');
    for (const specifier of specifiers) {
      const trimmed = specifier.trim();
      if (typeOnlySpecifierRegex.test(trimmed)) {
        continue;
      }
      const asMatch = trimmed.match(exportSpecifierRegex);
      if (!asMatch) {
        scanState.complete = false;
        continue;
      }
      const name = asMatch[1];
      if (isValidEsmExportName(name)) {
        names.add(name);
      } else if (name === 'default' || name === '__esModule') {
        // recognized default/__esModule re-export — not named, but scan stays complete
      } else {
        scanState.complete = false;
      }
    }
  }

  const namespaceReExportRegex = new RegExp(
    `export\\s+\\*\\s+as\\s+(${JS_IDENTIFIER_PATTERN})\\s+from\\s+['"][^'"]+['"]`,
    'gu'
  );
  while ((match = namespaceReExportRegex.exec(source)) !== null) {
    if (!codePositions[match.index]) continue;
    recognizedExportStarts.add(match.index);
    if (isValidEsmExportName(match[1])) names.add(match[1]);
  }
  if (hasCodeMatch(source, /export\s+\*\s+as\s+['"]/g, codePositions)) {
    scanState.complete = false;
  }

  // Handle `export * from './module'` re-exports
  if (filePath) {
    const starExportRegex = /export\s+\*\s+from\s+['"]([^'"]+)['"]/g;
    while ((match = starExportRegex.exec(source)) !== null) {
      if (!codePositions[match.index]) continue;
      recognizedExportStarts.add(match.index);
      const specifier = match[1];
      const resolvedPath = resolveReExportModule(filePath, specifier);
      if (!resolvedPath) {
        scanState.complete = false;
        continue;
      }
      if (visited.has(resolvedPath)) continue;
      if (path.extname(resolvedPath) === '.cjs') {
        scanState.complete = false;
        continue;
      }
      try {
        const reExportSource = readFileSync(resolvedPath, 'utf-8');
        if (hasCommonJsExports(reExportSource)) {
          scanState.complete = false;
          continue;
        }
        const reExportNames = getNamedExportsViaRegex(
          reExportSource,
          resolvedPath,
          visited,
          scanState
        );
        for (const name of reExportNames) {
          names.add(name);
        }
      } catch {
        scanState.complete = false;
      }
    }
  }

  // Default, empty, and type-only exports add no runtime named bindings, so an
  // otherwise complete scan can still use the default-only live proxy.
  const noNamedExportRegex = /export(?:\s+default\b|\s*\{\s*\}|\s+(?:type|interface|declare)\b)/g;
  while ((match = noNamedExportRegex.exec(source)) !== null) {
    if (!codePositions[match.index]) continue;
    recognizedExportStarts.add(match.index);
  }

  // Regex extraction must fail closed. Valid syntax can omit whitespace or put
  // comments between tokens, and silently treating an unmatched declaration as
  // default-only would mix a cache-backed default with local named exports.
  const exportKeywordRegex = /\bexport\b/g;
  while ((match = exportKeywordRegex.exec(source)) !== null) {
    if (!codePositions[match.index]) continue;
    if (!recognizedExportStarts.has(match.index)) {
      scanState.complete = false;
      break;
    }
  }

  return Array.from(names);
}

function getRequiredNamedExports(specifier: string): string[] | undefined {
  try {
    const projectRequire = createRequire(
      pathToFileURL(path.join(getPackageDetectionCwd(), 'package.json'))
    );
    const mod = projectRequire(specifier);
    const runtimeNamedKeys = Object.keys(mod).filter(
      (key) => key !== 'default' && key !== '__esModule'
    );
    if (runtimeNamedKeys.some((key) => !isValidEsmExportName(key))) return undefined;
    return runtimeNamedKeys;
  } catch {
    return undefined;
  }
}

function getPackageNamedExports(pkg: string): string[] | undefined {
  // Inspect the browser/import entry that Vite will bundle before considering
  // the package's require condition. Dual-format packages can expose different
  // APIs from those two entry points.
  const esmEntryPath = getInstalledPackageEntry(pkg, {
    conditions: ['browser', 'import', 'module', 'default'],
    resolveSubpathWithRequire: false,
  });
  if (esmEntryPath) {
    const inspection = inspectSharedExportsFromFile(esmEntryPath);

    // The selected Vite entry may itself be CommonJS. Requiring that exact file
    // gives us its runtime namespace without substituting a different condition.
    if (!inspection || inspection.commonJs || path.extname(esmEntryPath) === '.cjs') {
      return getRequiredNamedExports(esmEntryPath);
    }
    if (inspection.namedExports !== undefined) return inspection.namedExports;
    return undefined;
  }

  // Resolve from the project root (process.cwd()) so shared packages like React
  // are found even when the plugin lives in a nested pnpm store.
  return getRequiredNamedExports(pkg);
}

export function getSharedNamedExports(pkg: string, shareItem?: ShareItem): string[] | undefined {
  const configuredImport = shareItem?.shareConfig.import;
  if (typeof configuredImport === 'string') {
    const configuredImportPath = resolveConfiguredImportPath(configuredImport);
    // The configured source is authoritative. Do not fall back to the package
    // entry when that source is default-only or cannot be inspected: its export
    // shape may intentionally differ from the package root.
    const inspection = inspectSharedExportsFromFile(configuredImportPath);
    if (
      configuredImportPath &&
      (inspection?.commonJs || path.extname(configuredImportPath) === '.cjs')
    ) {
      return getRequiredNamedExports(configuredImportPath);
    }
    if (inspection?.namedExports !== undefined) return inspection.namedExports;
    return undefined;
  }

  return getPackageNamedExports(pkg);
}

export function getLocalProviderImportPath(pkg: string): string | undefined {
  try {
    const projectRequire = createRequire(
      pathToFileURL(path.join(getPackageDetectionCwd(), 'package.json'))
    );
    const resolved = resolveWorkspaceEsmEntry(pkg, projectRequire.resolve(pkg));
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
    return resolveWorkspaceEsmEntry(pkg, projectRequire.resolve(pkg));
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
  return !normalizeNodeModulePath(realResolved).includes('/node_modules/');
}

/**
 * When createRequire resolves a workspace package to a CJS entry (e.g. dist/index.cjs),
 * re-resolve via getInstalledPackageEntry with ESM-preferring conditions.
 *
 * Workspace packages produce browser code, so they must use the ESM build — CJS files
 * contain `module.exports` which is undefined in the browser. createRequire().resolve()
 * follows Node.js CJS conditions ["node", "require"], which matches exports["."].require.default
 * and returns the .cjs path for packages with dual ESM/CJS exports.
 */
function resolveWorkspaceEsmEntry(
  pkg: string,
  resolved: string,
  cwd = getPackageDetectionCwd()
): string {
  if (!isWorkspaceFilePath(resolved)) return resolved;
  const esmEntry = getInstalledPackageEntry(pkg, {
    cwd,
    conditions: ['browser', 'import', 'module', 'default'],
    resolveSubpathWithRequire: false,
  });
  if (esmEntry && isWorkspaceFilePath(esmEntry)) return esmEntry;
  return resolved;
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

function getSharedDependencyGraphPackageJson(pkg: string) {
  const installedPackageJson = getInstalledPackageJson(pkg, {
    packageName: getPackageName(pkg),
  })?.packageJson;
  if (installedPackageJson) return installedPackageJson;
  try {
    const projectRequire = createRequire(
      pathToFileURL(path.join(getPackageDetectionCwd(), 'package.json'))
    );
    const packageJsonPath = projectRequire.resolve(`${getPackageName(pkg)}/package.json`);
    return JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  } catch {
    // Fall back to workspace detection below.
  }
  return getWorkspacePackageJson(pkg);
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

function isSharedSingletonConsumedByPeer(pkg: string) {
  const options = getNormalizeModuleFederationOptions();
  const shared = options?.shared || {};
  // Subpath shares (for example `preact/hooks`) execute against their package
  // root during module evaluation. Keep the root singleton eager so that the
  // subpath cannot observe an as-yet-uninitialised lazy namespace.
  if (
    Object.entries(shared).some(
      ([key, item]) =>
        key !== pkg && key.startsWith(`${pkg}/`) && item.shareConfig.singleton === true
    )
  ) {
    return true;
  }
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
    const packageJson = getSharedDependencyGraphPackageJson(current);
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

function isRemoteOnlyContainer() {
  const options = getNormalizeModuleFederationOptions();
  return (
    Object.keys(options.exposes || {}).length > 0 && Object.keys(options.remotes || {}).length === 0
  );
}

function tryResolveImportFromPackageRoot(pkg: string, root: string): string | undefined {
  try {
    const projectRequire = createRequire(pathToFileURL(path.join(root, 'package.json')));
    return resolveWorkspaceEsmEntry(pkg, projectRequire.resolve(pkg), root);
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

const treeShakingProviderCacheMap: Record<string, VirtualModule> = {};
const materializedTreeShakingProviders = new Set<string>();
export const TREE_SHAKING_PROVIDER_TAG = '__treeShakingProvider__';
export const TREE_SHAKING_GRAPH_QUERY = '__mf_tree_shaking_graph__';

export function getTreeShakingGraphToken(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const queryStart = id.indexOf('?');
  if (queryStart === -1) return undefined;
  const hashStart = id.indexOf('#', queryStart);
  const query = id.slice(queryStart + 1, hashStart === -1 ? undefined : hashStart);
  const entry = query.split('&').find((part) => part.split('=', 1)[0] === TREE_SHAKING_GRAPH_QUERY);
  if (!entry) return undefined;
  const value = entry.slice(TREE_SHAKING_GRAPH_QUERY.length + 1);
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function stripTreeShakingGraphQuery(id: string): string {
  const queryStart = id.indexOf('?');
  if (queryStart === -1) return id;
  const hashStart = id.indexOf('#', queryStart);
  const pathname = id.slice(0, queryStart);
  const hash = hashStart === -1 ? '' : id.slice(hashStart);
  const query = id.slice(queryStart + 1, hashStart === -1 ? undefined : hashStart);
  const remaining = query
    .split('&')
    .filter(Boolean)
    .filter((part) => part.split('=', 1)[0] !== TREE_SHAKING_GRAPH_QUERY);
  return `${pathname}${remaining.length ? `?${remaining.join('&')}` : ''}${hash}`;
}

export function addTreeShakingGraphQuery(id: string, token: string): string {
  const cleanId = stripTreeShakingGraphQuery(id);
  const hashStart = cleanId.indexOf('#');
  const base = hashStart === -1 ? cleanId : cleanId.slice(0, hashStart);
  const hash = hashStart === -1 ? '' : cleanId.slice(hashStart);
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}${TREE_SHAKING_GRAPH_QUERY}=${encodeURIComponent(token)}${hash}`;
}

function getConcreteTreeShakingExportUsage(pkg: string, shareItem?: ShareItem) {
  return getTreeShakingExportUsage(pkg, shareItem, shareItem?.name);
}

export function getTreeShakingSharedProviderName(pkg: string): string {
  const { internalName, name } = getNormalizeModuleFederationOptions();
  return `${internalName || name}__tree_shaking__${packageNameEncode(pkg)}`;
}

export function getTreeShakingSharedProviderImportId(pkg: string): string {
  if (!treeShakingProviderCacheMap[pkg]) {
    treeShakingProviderCacheMap[pkg] = new VirtualModule(pkg, TREE_SHAKING_PROVIDER_TAG, '.js');
  }
  return treeShakingProviderCacheMap[pkg].getImportId();
}

export function hasTreeShakingSharedProvider(pkg: string, shareItem?: ShareItem): boolean {
  const usage = getConcreteTreeShakingExportUsage(pkg, shareItem);
  return materializedTreeShakingProviders.has(pkg) && usage?.kind === 'exports';
}

/**
 * Materialize the locally optimized provider as a small ESM container.
 *
 * The normal prebuild module remains the complete fallback. This container only
 * retains the selected exports and is installed as `treeShaking.get` by the
 * generated runtime record. Keeping the two getters distinct lets the Runtime
 * perform its normal usedExports compatibility check and safely choose the full
 * provider when the optimized one is insufficient.
 */
export function writeTreeShakingSharedProvider(pkg: string, shareItem?: ShareItem): void {
  const usage = getConcreteTreeShakingExportUsage(pkg, shareItem);
  if (
    usage?.kind !== 'exports' ||
    !usage.usedExports.length ||
    shareItem?.shareConfig.import === false
  ) {
    materializedTreeShakingProviders.delete(pkg);
    return;
  }
  const usedExports = usage.usedExports;

  const unsupportedExport = usedExports.find(
    (name) => name !== 'default' && !isValidEsmExportName(name)
  );
  if (unsupportedExport) {
    materializedTreeShakingProviders.delete(pkg);
    mfWarn(
      `Tree-shaking shared dependency "${pkg}" was disabled because export ` +
        `"${unsupportedExport}" cannot be represented by the generated ESM provider.`
    );
    return;
  }

  const provider =
    treeShakingProviderCacheMap[pkg] ||
    (treeShakingProviderCacheMap[pkg] = new VirtualModule(pkg, TREE_SHAKING_PROVIDER_TAG, '.js'));
  // Give the optimized provider a distinct module-graph namespace. Otherwise
  // Rollup sees the same package modules in both the complete fallback and the
  // optimized entry, hoists them into one shared chunk, and the "optimized"
  // entry downloads the complete dependency graph.
  const optimizedImportSource = addTreeShakingGraphQuery(
    getConcreteSharedImportSource(pkg, shareItem) || pkg,
    pkg
  );
  const namedExports = usedExports.filter((name) => name !== 'default');
  const namedImports = namedExports
    .map((name, index) => `${name} as __mfTreeShaken_${index}`)
    .join(', ');
  const importLines = [
    namedImports
      ? `import { ${namedImports} } from ${escapeGeneratedStringLiteral(optimizedImportSource)};`
      : '',
    usedExports.includes('default')
      ? `import __mfTreeShakenDefault from ${escapeGeneratedStringLiteral(optimizedImportSource)};`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  const namespaceEntries = [
    ...namedExports.map((name, index) => `[${JSON.stringify(name)}]: __mfTreeShaken_${index}`),
    ...(usedExports.includes('default')
      ? ['default: __mfTreeShakenDefault']
      : [
          `default: { ${namedExports
            .map((name, index) => `[${JSON.stringify(name)}]: __mfTreeShaken_${index}`)
            .join(', ')} }`,
        ]),
  ];

  provider.writeSync(
    `${importLines}
const __mfTreeShakenModule = { ${namespaceEntries.join(', ')} };
Object.defineProperty(__mfTreeShakenModule, "__esModule", {
  value: true,
  enumerable: false,
});
async function init() {}
function get() {
  return () => __mfTreeShakenModule;
}
const usedExports = ${JSON.stringify([...usedExports].sort())};
export { get, init, usedExports };
export default { get, init };
`,
    true
  );
  materializedTreeShakingProviders.add(pkg);
}

export function writePreBuildLibPath(pkg: string, shareItem?: ShareItem) {
  if (!preBuildCacheMap[pkg]) preBuildCacheMap[pkg] = new VirtualModule(pkg, PREBUILD_TAG, '.js');
  preBuildShareItemMap[pkg] = shareItem;
  const importSource = getConcreteSharedImportSource(pkg, shareItem) || pkg;
  writeTreeShakingSharedProvider(pkg, shareItem);
  if (pkg === 'react/compiler-runtime') {
    const reactShareItem =
      shareItem ??
      ({
        name: 'react',
        from: '',
        scope: 'default',
        shareConfig: { singleton: true },
      } as ShareItem);
    const reactCacheDescriptor = getSharedCacheDescriptorLiteral('react', reactShareItem);
    preBuildCacheMap[pkg].writeSync(
      `
    ${sharedCacheHelperCode}
    const __mfCacheGlobalKey = "__mf_module_cache__";
    export const c = function(size) {
      const cache = globalThis[__mfCacheGlobalKey]?.share;
      const sharedReact = cache && __mfReadSharedCache(cache, ${reactCacheDescriptor});
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
  const namedExports = getSharedNamedExports(pkg, shareItem) ?? [];
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
    export default Reflect.get(__mfPrebuildNamespace, "default") ?? __mfPrebuildNamespace;
  `,
      true
    );
    return;
  }
  preBuildCacheMap[pkg].writeSync(
    `
    import * as __mfPrebuildExports from ${escapeGeneratedStringLiteral(importSource)};
    export * from ${escapeGeneratedStringLiteral(importSource)};
    // Reflect access avoids bundler warnings for ESM packages without a
    // default export (for example antd/es/index.js), while preserving the
    // namespace fallback for packages that do provide one.
    export default Reflect.get(__mfPrebuildExports, "default") ?? __mfPrebuildExports;
  `,
    true
  );
}

/** Re-render already materialized wrappers after import analysis discovers exports. */
export function refreshTreeShakingModules() {
  for (const [pkg, shareItem] of Object.entries(preBuildShareItemMap)) {
    if (!shareItem?.shareConfig.treeShaking) continue;
    writePreBuildLibPath(pkg, shareItem);
    writeLoadShareModule(pkg, shareItem, 'build', false);
  }
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

function getSharedCacheReadExpression(cacheDescriptor: string, treeShakingConsumer?: string) {
  return treeShakingConsumer
    ? `__mfReadTreeShakingSharedSelection(__mfModuleCache.share, ${cacheDescriptor}, ${JSON.stringify(treeShakingConsumer)})`
    : `__mfReadSharedCache(__mfModuleCache.share, ${cacheDescriptor})`;
}

function generateEagerWorkspaceSingletonExports(
  namedExports: string[],
  importSource: string,
  cacheDescriptor: string,
  cacheOwner: string,
  treeShakingConsumer?: string
) {
  const namedExportVars = namedExports.map((_name, i) => `__mf_${i}`);
  const declarations =
    namedExports.length > 0
      ? ['let __mf_default;', ...namedExportVars.map((name) => `let ${name};`)].join('\n    ')
      : 'let __mf_default;';
  const assignments = [
    ...namedExports.map(
      (name, i) => `${namedExportVars[i]} = mod[${escapeGeneratedStringLiteral(name)}];`
    ),
    '__mf_default = mod.default ?? mod;',
  ].join('\n      ');
  const namedExportLine =
    namedExports.length > 0
      ? `\n    export { ${namedExports.map((name, i) => `${namedExportVars[i]} as ${name}`).join(', ')} };`
      : '';

  return `import * as __mfLocalShare from ${escapeGeneratedStringLiteral(importSource)};
    let exportModule = ${getSharedCacheReadExpression(cacheDescriptor, treeShakingConsumer)};
    if (exportModule === undefined) {
      Promise.resolve().then(() => {
        if (__mfReadSharedCache(__mfModuleCache.share, ${cacheDescriptor}) === undefined) {
          __mfWriteSharedCache(__mfModuleCache.share, ${cacheDescriptor}, __mfNormalizeShareModule(__mfLocalShare), ${cacheOwner});
        }
      });
      exportModule = __mfLocalShare;
    }
    ${declarations}
    const __mfApplyEagerShareExports = (mod) => {
      ${assignments}
    };
    __mfSubscribeSharedCache(__mfModuleCache.share, ${cacheDescriptor}, __mfApplyEagerShareExports);
    __mfApplyEagerShareExports(exportModule);
    export { __mf_default as default };${namedExportLine}`;
}
function generateLazyWorkspaceSingletonExports(
  namedExports: string[],
  importSource: string,
  cacheDescriptor: string,
  cacheOwner: string,
  treeShakingConsumer?: string,
  serveLocalFallback = false
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
      __mfWriteSharedCache(__mfModuleCache.share, ${cacheDescriptor}, exportModule, ${cacheOwner});
      __mfApplyLazyShareExports(exportModule);`;

  const body = `${declarations}
    const __mfApplyLazyShareExports = (mod) => {
      ${assignments}
    };
    __mfSubscribeSharedCache(__mfModuleCache.share, ${cacheDescriptor}, __mfApplyLazyShareExports);
    let exportModule = ${getSharedCacheReadExpression(cacheDescriptor, treeShakingConsumer)};
    if (exportModule === undefined) {
      if (import.meta.env.SSR${serveLocalFallback ? " || (import.meta.env.DEV && typeof __mfLocalShare !== 'undefined')" : ''}) {
        ${applyLocalFallback}
      } else {
        (__mfModuleCache.pendingShareLoads ||= []).push(initPromise.then(() => {
          exportModule = ${getSharedCacheReadExpression(cacheDescriptor, treeShakingConsumer)};
          if (exportModule !== undefined) {
            __mfApplyLazyShareExports(exportModule);
            return;
          }
          return import(${escapeGeneratedStringLiteral(importSource)}).then((mod) => {
            exportModule = __mfNormalizeShareModule(mod);
            __mfWriteSharedCache(__mfModuleCache.share, ${cacheDescriptor}, exportModule, ${cacheOwner});
          });
        }));
      }
    } else {
      __mfApplyLazyShareExports(exportModule);
    }
    export { __mf_default as default };${namedExportLine}`;

  return body;
}

const WORKSPACE_SINGLETON_SSR_LOCAL_SHARE = '__mfNormalizeShareModule(__mfLocalShare)';

export function prependWorkspaceSingletonSsrImport(code: string): string {
  if (!code.includes('if (import.meta.env.SSR)')) return code;
  if (!code.includes(WORKSPACE_SINGLETON_SSR_LOCAL_SHARE)) return code;

  const localShareImport =
    /^[ \t]*import\s+\*\s+as\s+__mfLocalShare\s+from\s+(['"])(.+?)\1\s*;?[ \t]*\r?\n?/gm;
  let hasLocalShareImport = false;
  code = code.replace(localShareImport, (statement) => {
    if (hasLocalShareImport) return '';
    hasLocalShareImport = true;
    return statement;
  });
  if (hasLocalShareImport) return code;

  const importMatch =
    code.match(
      /initPromise\.then\(\(\)\s*=>\s*\{[\s\S]*?\breturn import\((["'])(.+?)\1\)\.then\(\(mod\)\s*=>\s*\{[\s\S]*?__mfApplyLazyShareExports/
    ) ??
    code.match(
      /initPromise\.then\(\(\)\s*=>\s*\n\s*import\((["'])(.+?)\1\)\.then\(\(mod\)\s*=>\s*\{[\s\S]*?__mfApplyLazyShareExports/
    ) ??
    code.match(/import\((["'])(.+?)\1\)/);
  if (!importMatch) return code;

  const quote = importMatch[1];
  const importSource = importMatch[2];
  return `import * as __mfLocalShare from ${quote}${importSource}${quote};\n${code}`;
}

function generateDeferredHostProvidedExports(
  namedExports: string[],
  pkg: string,
  cacheDescriptor: string,
  treeShakingConsumer?: string
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
    let exportModule = ${getSharedCacheReadExpression(cacheDescriptor, treeShakingConsumer)};
    if (exportModule === undefined) {
      (__mfModuleCache.pendingShareLoads ||= []).push(initPromise.then(() => {
        exportModule = ${getSharedCacheReadExpression(cacheDescriptor, treeShakingConsumer)};
        if (exportModule === undefined) {
          throw new Error("[Module Federation] Shared module ${pkg} was imported before federation bootstrap finished.");
        }
        __mfApplyHostProvidedExports(exportModule);
      }));
    } else {
      __mfApplyHostProvidedExports(exportModule);
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
      const normalized = (() => {
        ${generateShareModuleUnwrapCode({ source: 'mod', preserveNamedExports: true })}
      })();
      return normalized && Object.getPrototypeOf(normalized) === null
        ? Object.assign({}, normalized)
        : normalized;
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
  const cacheDescriptor = getSharedCacheDescriptorLiteral(pkg, shareItem);
  const cacheOwner = JSON.stringify(getNormalizeModuleFederationOptions().name);
  const treeShakingConsumer =
    command === 'build' && shareItem.shareConfig.treeShaking
      ? getNormalizeModuleFederationOptions().name
      : undefined;

  // import: false means the host must provide this module — the remote has no local copy.
  // Generate a minimal loadShare module that just delegates to the runtime.
  // No prebuild imports, no dev warming imports.
  if (shareItem.shareConfig.import === false) {
    // Try to detect named exports from locally installed devDependencies.
    // This enables `import { ref } from 'vue'` even though the module is provided by the host.
    // For packages that aren't installed, fall back to default-only export.
    const detectedNamedExports = getPackageNamedExports(pkg);
    const namedExports = detectedNamedExports ?? [];
    let exportLine: string;
    if (namedExports.length > 0) {
      exportLine = generateDeferredHostProvidedExports(
        namedExports,
        pkg,
        cacheDescriptor,
        treeShakingConsumer
      );
    } else {
      if (detectedNamedExports === undefined) {
        mfWarn(
          `Shared dependency "${pkg}" has import: false but is not installed locally.\n` +
            `  Named imports (e.g. import { ... } from '${pkg}') will not work in production builds.\n` +
            `  Install it as a devDependency to enable named export detection.`
        );
      }
      exportLine = generateDeferredHostProvidedExports(
        [],
        pkg,
        cacheDescriptor,
        treeShakingConsumer
      );
    }
    loadShareCacheMap[pkg].writeSync(
      `
    ${getRuntimeInitPromiseBootstrapCode()}
    ${importLine}
    ${sharedCacheHelperCode}
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
  const coherentLocalSource = concreteSharedImportSource || localProviderPath || devImportSource;
  const isWorkspacePackage =
    isWorkspacePackageEntry(pkg, localProviderPath) ||
    isWorkspacePackageEntry(pkg, concreteSharedImportSource);
  const lazyLocalFallbackSource =
    command !== 'build'
      ? concreteSharedImportSource || localProviderPath || devImportSource
      : concreteSharedImportSource || localProviderPath || sharedImportSource;
  const skipServePrebuildWarmup = command !== 'build' && (pkg === 'lit' || pkg.startsWith('lit/'));
  const detectedNamedExports = getSharedNamedExports(pkg, shareItem);
  const namedExports = detectedNamedExports ?? [];
  const hasCompleteExportCoverage = detectedNamedExports !== undefined;
  const isWorkspaceSingleton = isWorkspacePackage && shareItem.shareConfig.singleton === true;
  const isDefaultShareScope =
    shareItem.scope === undefined ||
    shareItem.scope === 'default' ||
    (Array.isArray(shareItem.scope) && shareItem.scope[0] === 'default');
  const usesDeferredSingletonFallback =
    hasCompleteExportCoverage &&
    (isWorkspaceSingleton ||
      (command !== 'build' &&
        isRemoteOnlyContainer() &&
        shareItem.shareConfig.singleton === true) ||
      (command === 'build' &&
        isRemoteOnlyContainer() &&
        shareItem.shareConfig.singleton === true &&
        !isDefaultShareScope));
  const servesRemoteSingletonFallback =
    command !== 'build' && isRemoteOnlyContainer() && shareItem.shareConfig.singleton === true;
  const isConsumedByPeerSingleton = isSharedSingletonConsumedByPeer(pkg);
  const usesEntryInjectedRemoteFallback =
    hasCompleteExportCoverage &&
    command !== 'build' &&
    !isWorkspaceSingleton &&
    isRemoteOnlyContainer() &&
    shareItem.shareConfig.singleton === true &&
    getNormalizeModuleFederationOptions().hostInitInjectLocation === 'entry' &&
    isConsumedByPeerSingleton;
  const usesEagerWorkspaceFallback =
    hasCompleteExportCoverage && isWorkspaceSingleton && isConsumedByPeerSingleton;
  const usesDeferredTreeShakingFallback = hasCompleteExportCoverage && Boolean(treeShakingConsumer);
  let exportLine: string;
  let initBlock = '';
  if (usesDeferredTreeShakingFallback) {
    importLine = `${getRuntimeInitPromiseBootstrapCode()}\n    ${importLine}`;
    exportLine = generateLazyWorkspaceSingletonExports(
      namedExports,
      lazyLocalFallbackSource,
      cacheDescriptor,
      cacheOwner,
      treeShakingConsumer,
      command !== 'build' &&
        (isWorkspaceSingleton || isWorkspacePackage || servesRemoteSingletonFallback)
    );
  } else if (usesEagerWorkspaceFallback || usesEntryInjectedRemoteFallback) {
    exportLine = generateEagerWorkspaceSingletonExports(
      namedExports,
      lazyLocalFallbackSource,
      cacheDescriptor,
      cacheOwner,
      treeShakingConsumer
    );
  } else if (usesDeferredSingletonFallback) {
    importLine = `${getRuntimeInitPromiseBootstrapCode()}\n    ${importLine}`;
    exportLine = generateLazyWorkspaceSingletonExports(
      namedExports,
      lazyLocalFallbackSource,
      cacheDescriptor,
      cacheOwner,
      treeShakingConsumer,
      command !== 'build' &&
        (isWorkspaceSingleton || isWorkspacePackage || servesRemoteSingletonFallback)
    );
  } else if (detectedNamedExports === undefined) {
    // Unknown export coverage cannot be rebound safely: a live default backed by
    // the shared cache plus `export *` backed by the local source can mix two
    // singleton instances. Keep the complete proxy on the local namespace.
    exportLine = `const __mfDefaultExport = (() => {
      ${generateShareModuleUnwrapCode({
        source: '__mfLocalShare',
        preserveNamedExports: false,
        stopWithReturn: 'defaultExport ?? current',
      })}
    })();
    export default __mfDefaultExport;
    export * from ${escapeGeneratedStringLiteral(coherentLocalSource)}`;
    initBlock = `exportModule = __mfNormalizeShareModule(__mfLocalShare);
      __mfWriteSharedCache(__mfModuleCache.share, ${cacheDescriptor}, exportModule, ${cacheOwner});`;
  } else if (namedExports.length > 0 && shareItem.shareConfig.singleton === true) {
    const namedExportVars = namedExports.map((_name, i) => `__mf_${i}`);
    const declarations = [
      'let __mfDefaultExport;',
      ...namedExportVars.map((name) => `let ${name};`),
    ].join('\n    ');
    const assignments = [
      ...namedExports.map(
        (name, i) => `${namedExportVars[i]} = mod[${escapeGeneratedStringLiteral(name)}];`
      ),
      `__mfDefaultExport = (() => {
        ${generateShareModuleUnwrapCode({
          source: 'mod',
          preserveNamedExports: false,
          stopWithReturn: 'defaultExport ?? current',
        })}
      })();`,
    ].join('\n      ');
    const namedExportLine = `export { ${namedExports.map((name, i) => `__mf_${i} as ${name}`).join(', ')} };`;
    exportLine = `${declarations}
    const __mfApplySharedExports = (mod) => {
      ${assignments}
    };
    __mfSubscribeSharedCache(__mfModuleCache.share, ${cacheDescriptor}, __mfApplySharedExports);
    __mfApplySharedExports(exportModule);
    export { __mfDefaultExport as default };
    ${namedExportLine}`;
    initBlock = `exportModule = __mfNormalizeShareModule(__mfLocalShare);
      __mfWriteSharedCache(__mfModuleCache.share, ${cacheDescriptor}, exportModule, ${cacheOwner});`;
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
      __mfWriteSharedCache(__mfModuleCache.share, ${cacheDescriptor}, exportModule, ${cacheOwner});`;
  } else if (shareItem.shareConfig.singleton === true) {
    exportLine = `let __mfDefaultExport;
    const __mfApplySharedDefaultExport = (mod) => {
      __mfDefaultExport = mod.default ?? mod;
    };
    __mfSubscribeSharedCache(__mfModuleCache.share, ${cacheDescriptor}, __mfApplySharedDefaultExport);
    __mfApplySharedDefaultExport(exportModule);
    export { __mfDefaultExport as default };
    export * from ${escapeGeneratedStringLiteral(sharedImportSource)}`;
    initBlock = `exportModule = __mfNormalizeShareModule(__mfLocalShare);
      __mfWriteSharedCache(__mfModuleCache.share, ${cacheDescriptor}, exportModule, ${cacheOwner});`;
  } else {
    exportLine = `export default exportModule.default ?? exportModule\n    export * from ${escapeGeneratedStringLiteral(sharedImportSource)}`;
    initBlock = `exportModule = __mfNormalizeShareModule(__mfLocalShare);
      __mfWriteSharedCache(__mfModuleCache.share, ${cacheDescriptor}, exportModule, ${cacheOwner});`;
  }

  const staticLocalShareSource =
    detectedNamedExports === undefined
      ? coherentLocalSource
      : skipServePrebuildWarmup
        ? devImportSource
        : sharedImportSource;
  const prebuildImportLine =
    usesEagerWorkspaceFallback || usesEntryInjectedRemoteFallback
      ? ''
      : usesDeferredSingletonFallback || usesDeferredTreeShakingFallback
        ? servesRemoteSingletonFallback ||
          (usesDeferredSingletonFallback &&
            command !== 'build' &&
            (isWorkspaceSingleton || isWorkspacePackage))
          ? `import * as __mfLocalShare from ${escapeGeneratedStringLiteral(lazyLocalFallbackSource)};`
          : ''
        : `import * as __mfLocalShare from ${escapeGeneratedStringLiteral(staticLocalShareSource)};`;
  const devDynamicImportLine = isWorkspacePackage
    ? ''
    : usesDeferredSingletonFallback || usesDeferredTreeShakingFallback
      ? ''
      : command !== 'build' && !skipServePrebuildWarmup
        ? `;() => import(${escapeGeneratedStringLiteral(devImportSource)}).catch(() => {});`
        : '';

  const moduleBody =
    usesDeferredSingletonFallback || usesDeferredTreeShakingFallback
      ? `
    ${prebuildImportLine}
    ${devDynamicImportLine}
    ${importLine}
    ${sharedCacheHelperCode}
    ${normalizeLocalShareModuleCode}
    ${exportLine}
  `
      : `
    ${prebuildImportLine}
    ${devDynamicImportLine}
    ${importLine}
    ${sharedCacheHelperCode}
    ${normalizeLocalShareModuleCode}
    let exportModule = ${getSharedCacheReadExpression(cacheDescriptor, treeShakingConsumer)}
    if (exportModule === undefined) {
      ${initBlock}
    }
    ${exportLine}
  `;

  loadShareCacheMap[pkg].writeSync(moduleBody, true);
}

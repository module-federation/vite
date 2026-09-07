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
import { createReactMixedModeRuntimeGuard } from '../plugins/pluginReactMixedModeGuard';
import { createCodePositionMap } from '../utils/codePositionMap';
import { mfWarn } from '../utils/logger';
import {
  getNormalizeModuleFederationOptions,
  type NormalizedModuleFederationOptions,
  type NormalizedShared,
  type ShareItem,
} from '../utils/normalizeModuleFederationOptions';
import {
  getInstalledPackageEntry,
  getInstalledPackageJson,
  getPackageDetectionCwd,
  getPackageName,
  getSharedCacheDescriptor,
  packageNameDecode,
  packageNameEncode,
  sharedCacheHelperCode,
} from '../utils/packageUtils';
import { normalizeNodeModulePath } from '../utils/pathNormalization';
import { getTreeShakingExportUsage, type TreeShakingExportUsage } from '../utils/treeShaking';
import { findLikelyTypeArgumentEnd } from '../utils/typeArgumentScanner';
import VirtualModule, { MF_OWNER_INFIX, normalizeVirtualModuleId } from '../utils/VirtualModule';
import {
  getModuleCacheGlobalKey,
  getRuntimeInitPromiseBootstrapCode,
  getRuntimeInitStatusImportId,
  getRuntimeModuleCacheBootstrapCode,
} from './virtualRuntimeInitStatus';
import { getFederationScopeKey } from './virtualModuleScope';

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

type CachedNamedExports = { value: string[] | undefined };

const packageNamedExportsCache = new Map<string, CachedNamedExports>();
const sharedExportInspectionCache = new Map<string, SharedExportInspection | undefined>();

export function invalidateSharedExportInspectionCache(filePath: string): void {
  if (!/(?:^|[/\\])node_modules(?:[/\\]|$)/.test(filePath)) {
    sharedExportInspectionCache.clear();
  }
}

type NamedExportScanState = {
  complete: boolean;
};

const DEFAULT_SHARED_EXPORT_CONDITIONS = ['browser', 'import', 'module', 'default'];

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
  if (hasCodeMatch(source, /\bmodule\s*(?:\.exports|\[\s*['"]exports['"]\s*\])/g, codePositions)) {
    return true;
  }

  const exportsRegex = /\bexports\s*(?:\.|\[|[,)]|=(?!=|>))/g;
  let match: RegExpExecArray | null;
  while ((match = exportsRegex.exec(source)) !== null) {
    if (!codePositions[match.index]) continue;

    // `exports` is a CommonJS marker only when it is a standalone identifier.
    // Member properties such as `wrapper.exports` describe arbitrary objects
    // and do not determine the containing file's module format.
    let previousCodeIndex = match.index - 1;
    while (
      previousCodeIndex >= 0 &&
      (/\s/.test(source[previousCodeIndex]) || !codePositions[previousCodeIndex])
    ) {
      previousCodeIndex--;
    }
    if (source[previousCodeIndex] === '.') continue;

    return true;
  }
  return false;
}

function inspectSharedExportsFromFile(
  entryPath: string | undefined,
  exportConditions = DEFAULT_SHARED_EXPORT_CONDITIONS
): SharedExportInspection | undefined {
  if (!entryPath) return undefined;
  const cacheKey = `${entryPath}\0${exportConditions.join('\0')}`;
  if (sharedExportInspectionCache.has(cacheKey)) {
    return sharedExportInspectionCache.get(cacheKey);
  }

  try {
    const source = readFileSync(entryPath, 'utf-8');
    const scanState: NamedExportScanState = { complete: true };
    const namedExports = getNamedExportsViaRegex(
      source,
      entryPath,
      undefined,
      scanState,
      exportConditions
    );
    const commonJs = hasCommonJsExports(source);
    const inspection = {
      // A complete empty ESM scan is a known default-only export surface. Keep
      // unresolved re-exports and CommonJS sources conservative instead.
      namedExports: scanState.complete && !commonJs ? namedExports : undefined,
      commonJs,
    };
    sharedExportInspectionCache.set(cacheKey, inspection);
    return inspection;
  } catch {
    sharedExportInspectionCache.set(cacheKey, undefined);
    return undefined;
  }
}

function getMutableExportsFromFile(
  entryPath: string | undefined,
  exportConditions = DEFAULT_SHARED_EXPORT_CONDITIONS,
  visited = new Set<string>()
): string[] {
  // Cache-backed `let` exports only react to provider replacement. Forwarding
  // from the ESM source is required to observe synchronous binding mutations.
  if (!entryPath || visited.has(entryPath)) return [];
  visited.add(entryPath);

  try {
    const source = readFileSync(entryPath, 'utf-8');
    const codePositions = createCodePositionMap(source);
    const mutableBindings = new Set<string>();
    const mutableExports = new Set<string>();
    let match: RegExpExecArray | null;
    const declarationRegex = new RegExp(
      `\\b(?:export\\s+)?(?:let|var)\\s+(${JS_IDENTIFIER_PATTERN})`,
      'gu'
    );
    let declarationScanIndex = 0;
    let braceDepth = 0;
    while ((match = declarationRegex.exec(source)) !== null) {
      if (!codePositions[match.index]) continue;
      for (let index = declarationScanIndex; index < match.index; index++) {
        if (!codePositions[index]) continue;
        if (source[index] === '{') braceDepth++;
        else if (source[index] === '}') braceDepth--;
      }
      declarationScanIndex = match.index;
      if (braceDepth !== 0) continue;
      mutableBindings.add(match[1]);
      if (match[0].trimStart().startsWith('export')) mutableExports.add(match[1]);
    }

    const listRegex = /export\s*\{([^}]+)\}(?:\s*from\s*['"]([^'"]+)['"])?/g;
    while ((match = listRegex.exec(source)) !== null) {
      if (!codePositions[match.index]) continue;
      const reExportPath = match[2]
        ? resolveReExportModule(entryPath, match[2], exportConditions)
        : undefined;
      const reExportedMutable = new Set(
        reExportPath ? getMutableExportsFromFile(reExportPath, exportConditions, visited) : []
      );
      for (const rawSpecifier of match[1].split(',')) {
        const specifier = rawSpecifier.trim();
        if (!specifier || specifier.startsWith('type ')) continue;
        const parts = specifier.split(/\s+as\s+/);
        const local = parts[0].trim();
        const exported = (parts[1] || local).trim();
        if (
          isValidEsmExportName(exported) &&
          (mutableBindings.has(local) || reExportedMutable.has(local))
        ) {
          mutableExports.add(exported);
        }
      }
    }

    const starExportRegex = /export\s+\*\s+from\s+['"]([^'"]+)['"]/g;
    while ((match = starExportRegex.exec(source)) !== null) {
      if (!codePositions[match.index]) continue;
      const resolved = resolveReExportModule(entryPath, match[1], exportConditions);
      for (const name of getMutableExportsFromFile(resolved, exportConditions, visited)) {
        mutableExports.add(name);
      }
    }
    visited.delete(entryPath);
    return Array.from(mutableExports);
  } catch {
    visited.delete(entryPath);
    return [];
  }
}

function getSharedMutableExports(
  pkg: string,
  shareItem?: ShareItem,
  exportConditions = DEFAULT_SHARED_EXPORT_CONDITIONS
): string[] {
  const configuredImport = shareItem?.shareConfig.import;
  const entryPath =
    typeof configuredImport === 'string'
      ? resolveConfiguredImportPath(configuredImport, exportConditions)
      : getInstalledPackageEntry(pkg, {
          conditions: exportConditions,
          resolveSubpathWithRequire: false,
        });
  return getMutableExportsFromFile(entryPath, exportConditions);
}

function resolveConfiguredImportPath(
  importSource: string,
  exportConditions = DEFAULT_SHARED_EXPORT_CONDITIONS
): string | undefined {
  if (path.isAbsolute(importSource)) {
    return resolveFileLikeModule(importSource);
  }

  const projectRoot = getPackageDetectionCwd();
  if (importSource.startsWith('.')) {
    return resolveFileLikeModule(path.resolve(projectRoot, importSource));
  }

  const esmEntry = getInstalledPackageEntry(importSource, {
    conditions: exportConditions,
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

function resolveReExportModule(
  filePath: string,
  specifier: string,
  exportConditions: string[]
): string | undefined {
  if (specifier.startsWith('.')) return resolveRelativeModule(filePath, specifier);

  // Package entry files commonly re-export their public API from another
  // package (for example, Vue re-exports from @vue/runtime-dom). Resolve the
  // re-export with ESM-oriented conditions so we inspect the same file that
  // Vite will load, rather than a CommonJS fallback selected by require.
  const esmEntry = getInstalledPackageEntry(specifier, {
    cwd: path.dirname(filePath),
    conditions: exportConditions,
    resolveSubpathWithRequire: false,
  });
  if (esmEntry) return esmEntry;

  try {
    return resolveFileLikeModule(createRequire(pathToFileURL(filePath)).resolve(specifier));
  } catch {
    return undefined;
  }
}

/** Marks a template-literal frame whose text (not its interpolation) is being scanned. */
const TEMPLATE_TEXT = Symbol('templateText');

function getAdditionalTopLevelDeclaratorNames(
  source: string,
  start: number,
  codePositions: boolean[]
): string[] | undefined {
  const names: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  let canStartRegex = true;
  // Template literals cannot be treated as plain quoted strings: a nested
  // template inside a `${...}` interpolation would close the outer one early,
  // after which real template text is scanned as code. That desync miscounts
  // brace depth and lets constructs like `</Tag>` be read as a regex, so the
  // scan reports a phantom top-level comma. Track template text and
  // interpolations explicitly instead. Entries are either TEMPLATE_TEXT or the
  // brace depth at which an interpolation opened.
  const templateFrames: (typeof TEMPLATE_TEXT | number)[] = [];
  const inTemplateText = () => templateFrames[templateFrames.length - 1] === TEMPLATE_TEXT;

  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (inTemplateText()) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '$' && source[index + 1] === '{') {
        templateFrames.push(depth);
        index++;
        canStartRegex = true;
      } else if (char === '`') {
        templateFrames.pop();
        canStartRegex = false;
      }
      continue;
    }
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
    if (char === '`') {
      templateFrames.push(TEMPLATE_TEXT);
      canStartRegex = false;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      canStartRegex = false;
      continue;
    }
    if (char === '<' && source[index + 1] === '/') {
      const jsxClosingTag = source
        .slice(index)
        .match(/^<\/\s*(?:[$_\p{ID_Start}][$_\u200C\u200D\p{ID_Continue}.:-]*\s*)?>/u);
      if (jsxClosingTag) {
        index += jsxClosingTag[0].length - 1;
        canStartRegex = false;
        continue;
      }
    }
    if (char === '/' && source[index + 1] === '/') {
      index = source.indexOf('\n', index + 2);
      if (index === -1) return names;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const commentEnd = source.indexOf('*/', index + 2);
      if (commentEnd === -1) return undefined;
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
        if (regexChar === '\n' || regexChar === '\r') return undefined;
      }
      if (!closed) return undefined;
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
      if (depth === 0 && templateFrames.length === 0 && token === 'export') {
        let previous = tokenStart - 1;
        while (/\s/.test(source[previous] || '')) previous--;
        if (
          source[previous] !== '.' &&
          /^\s+(?:(?:async\s+)?function\b|(?:abstract\s+)?class\b|const\b|let\b|var\b|enum\b|namespace\b|module\b|interface\b|type\b|declare\b|default\b|\{|\*)/.test(
            source.slice(index + 1)
          )
        ) {
          return names;
        }
      }
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
    if (char === '<') {
      const typeArgumentEnd = findLikelyTypeArgumentEnd(source, index, codePositions);
      if (typeArgumentEnd !== undefined) {
        index = typeArgumentEnd;
        canStartRegex = false;
        continue;
      }
    }
    if (char === '(' || char === '[' || char === '{') {
      depth++;
      canStartRegex = true;
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      // A `}` closing a `${...}` interpolation returns to the template text it
      // was opened from rather than unwinding the surrounding brace depth.
      if (
        char === '}' &&
        templateFrames.length > 0 &&
        templateFrames[templateFrames.length - 1] === depth
      ) {
        templateFrames.pop();
        canStartRegex = false;
        continue;
      }
      depth = Math.max(0, depth - 1);
      canStartRegex = false;
      continue;
    }
    // Commas and semicolons inside an interpolation belong to that expression,
    // not to the declarator list, even when the brace depth happens to be 0.
    if (templateFrames.length === 0 && depth === 0 && char === ',') {
      let bindingStart = index + 1;
      while (/\s/.test(source[bindingStart] || '')) bindingStart++;
      const binding = source
        .slice(bindingStart)
        .match(new RegExp(`^(${JS_IDENTIFIER_PATTERN})`, 'u'));
      if (!binding || !isValidEsmExportName(binding[1])) return undefined;
      names.push(binding[1]);
      index = bindingStart + binding[1].length - 1;
      canStartRegex = false;
      continue;
    }
    if (templateFrames.length === 0 && depth === 0 && char === ';') return names;
    if (!/\s/.test(char)) {
      canStartRegex = char !== '.';
    }
  }

  return names;
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
  scanState: NamedExportScanState = { complete: true },
  exportConditions = DEFAULT_SHARED_EXPORT_CONDITIONS
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
  // `export const a = 1, b = 2`; enumerate later simple bindings so every
  // declarator can be represented by the live proxy.
  const exportedVariableDeclarationRegex = /export\s+(?:const|let|var)\s+/g;
  while ((match = exportedVariableDeclarationRegex.exec(source)) !== null) {
    if (!codePositions[match.index]) continue;
    const additionalNames = getAdditionalTopLevelDeclaratorNames(
      source,
      exportedVariableDeclarationRegex.lastIndex,
      codePositions
    );
    if (additionalNames === undefined) {
      scanState.complete = false;
    } else {
      for (const name of additionalNames) names.add(name);
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
      if (!trimmed) {
        // empty specifier from a trailing comma in the export list — valid syntax, not a scan gap
        continue;
      }
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
      const resolvedPath = resolveReExportModule(filePath, specifier, exportConditions);
      if (!resolvedPath) {
        scanState.complete = false;
        continue;
      }
      if (visited.has(resolvedPath)) continue;
      try {
        const reExportSource = readFileSync(resolvedPath, 'utf-8');
        if (path.extname(resolvedPath) === '.cjs' || hasCommonJsExports(reExportSource)) {
          // ESM barrels can re-export a CommonJS entry (Vue's Node entry does
          // this). Preserve its runtime keys so consumers such as vue-demi do
          // not receive an empty namespace during SSR bundling.
          const requiredNames = getRequiredNamedExports(resolvedPath);
          if (!requiredNames?.length) {
            scanState.complete = false;
            continue;
          }
          for (const name of requiredNames) names.add(name);
          continue;
        }
        const reExportNames = getNamedExportsViaRegex(
          reExportSource,
          resolvedPath,
          visited,
          scanState,
          exportConditions
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
    if (recognizedExportStarts.has(match.index)) continue;

    // A member named `export` is not an export declaration.
    let previousCodeIndex = match.index - 1;
    while (
      previousCodeIndex >= 0 &&
      (/\s/.test(source[previousCodeIndex]) || !codePositions[previousCodeIndex])
    ) {
      previousCodeIndex--;
    }
    if (source[previousCodeIndex] === '.') continue;

    let nextCodeIndex = match.index + match[0].length;
    while (
      nextCodeIndex < source.length &&
      (/\s/.test(source[nextCodeIndex]) || !codePositions[nextCodeIndex])
    ) {
      nextCodeIndex++;
    }
    if (source[nextCodeIndex] === '(') continue;

    // A property named `export` in an object or type literal (`export:`, `export?:`) is not one either.
    let memberIndex = nextCodeIndex;
    if (source[memberIndex] === '?') {
      memberIndex++;
      while (
        memberIndex < source.length &&
        (/\s/.test(source[memberIndex]) || !codePositions[memberIndex])
      ) {
        memberIndex++;
      }
    }
    if (source[memberIndex] === ':') continue;

    scanState.complete = false;
    break;
  }

  return Array.from(names);
}

/** `process._getActiveHandles` is undocumented, so it is absent from @types/node. */
type ProcessWithActiveHandles = NodeJS.Process & {
  _getActiveHandles?: () => unknown[];
};

/**
 * Reading a module's export names runs its top-level code inside the build
 * process, and getPackageNamedExports deliberately resolves the browser entry.
 * A browser entry may open a handle Node never closes — react-dom/server.browser
 * holds a module-scope MessageChannel — and one ref'd handle keeps the event loop
 * alive forever, so `vite build` writes a correct bundle and then never exits.
 *
 * Unref'ing whatever the require created is safe here because the module is
 * loaded purely to read Object.keys off it and is never used afterwards. The
 * handle list is undocumented, so its absence degrades to the previous behaviour
 * rather than failing the build. Side effects that are not handles (an exit
 * listener, a global mutation) are still not contained.
 */
function getRequiredNamedExports(specifier: string): string[] | undefined {
  const getActiveHandles = (process as ProcessWithActiveHandles)._getActiveHandles;
  const handlesBeforeRequire =
    typeof getActiveHandles === 'function' ? new Set(getActiveHandles.call(process)) : undefined;
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
  } finally {
    // finally, not after the require, so a module that throws part-way through
    // its side effects is cleaned up too.
    if (handlesBeforeRequire && typeof getActiveHandles === 'function') {
      for (const handle of getActiveHandles.call(process)) {
        if (handlesBeforeRequire.has(handle)) continue;
        const unref = (handle as { unref?: () => void } | null)?.unref;
        if (typeof unref === 'function') unref.call(handle);
      }
    }
  }
}

function getPackageNamedExports(
  pkg: string,
  exportConditions = DEFAULT_SHARED_EXPORT_CONDITIONS
): string[] | undefined {
  // Inspect the entry selected by the active Vite environment before
  // considering the package's require condition. Dual-format and
  // browser/server packages can expose different APIs from those entry points.
  const esmEntryPath = getInstalledPackageEntry(pkg, {
    conditions: exportConditions,
    resolveSubpathWithRequire: false,
  });
  if (esmEntryPath) {
    const cacheKey = !isWorkspaceFilePath(esmEntryPath)
      ? `${getPackageDetectionCwd()}\0${esmEntryPath}\0${exportConditions.join('\0')}`
      : undefined;
    const cached = cacheKey ? packageNamedExportsCache.get(cacheKey) : undefined;
    if (cached) return cached.value;

    const inspection = inspectSharedExportsFromFile(esmEntryPath, exportConditions);

    // The selected Vite entry may itself be CommonJS. Requiring that exact file
    // gives us its runtime namespace without substituting a different condition.
    const value =
      !inspection || inspection.commonJs || path.extname(esmEntryPath) === '.cjs'
        ? getRequiredNamedExports(esmEntryPath)
        : inspection.namedExports;
    if (cacheKey) packageNamedExportsCache.set(cacheKey, { value });
    return value;
  }

  // Resolve from the project root (process.cwd()) so shared packages like React
  // are found even when the plugin lives in a nested pnpm store.
  return getRequiredNamedExports(pkg);
}

export function getSharedNamedExports(
  pkg: string,
  shareItem?: ShareItem,
  exportConditions = DEFAULT_SHARED_EXPORT_CONDITIONS
): string[] | undefined {
  const configuredImport = shareItem?.shareConfig.import;
  if (typeof configuredImport === 'string') {
    const configuredImportPath = resolveConfiguredImportPath(configuredImport, exportConditions);
    // The configured source is authoritative. Do not fall back to the package
    // entry when that source is default-only or cannot be inspected: its export
    // shape may intentionally differ from the package root.
    const inspection = inspectSharedExportsFromFile(configuredImportPath, exportConditions);
    if (
      configuredImportPath &&
      (inspection?.commonJs || path.extname(configuredImportPath) === '.cjs')
    ) {
      return getRequiredNamedExports(configuredImportPath);
    }
    if (inspection?.namedExports !== undefined) return inspection.namedExports;
    return undefined;
  }

  return getPackageNamedExports(pkg, exportConditions);
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

function isSharedSingletonConsumedByPeer(
  pkg: string,
  options: NormalizedModuleFederationOptions = getNormalizeModuleFederationOptions(),
  requireFederationRuntimeDependency = false
) {
  const shared = options?.shared || {};
  // Subpath shares (for example `preact/hooks`) execute against their package
  // root during module evaluation. Keep the root singleton eager so that the
  // subpath cannot observe an as-yet-uninitialised lazy namespace.
  if (
    !requireFederationRuntimeDependency &&
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
  const reachesPkg = (
    current: string,
    seen: Set<string>,
    hasFederationRuntimeDependency = false
  ): boolean => {
    const packageJson = getSharedDependencyGraphPackageJson(current);
    const dependencies = getDependencyNames(packageJson);
    const usesFederationRuntime = dependencies.some(
      (dependency) =>
        dependency === '@module-federation/enhanced' ||
        dependency === '@module-federation/runtime' ||
        dependency === '@module-federation/runtime-core'
    );
    const runtimeIsReachable = hasFederationRuntimeDependency || usesFederationRuntime;
    for (const dependency of dependencies) {
      const sharedDependency = sharedKeyByPackageName.get(dependency);
      if (!sharedDependency) continue;
      if (sharedDependency === pkg)
        return !requireFederationRuntimeDependency || runtimeIsReachable;
      if (seen.has(sharedDependency)) continue;
      seen.add(sharedDependency);
      if (reachesPkg(sharedDependency, seen, runtimeIsReachable)) return true;
    }
    return false;
  };

  return Array.from(sharedKeyByPackageName.values()).some(
    (sharedPkg) => sharedPkg !== pkg && reachesPkg(sharedPkg, new Set([sharedPkg]))
  );
}

function isRemoteOnlyContainer(
  options: NormalizedModuleFederationOptions = getNormalizeModuleFederationOptions()
) {
  return (
    Object.keys(options.exposes || {}).length > 0 && Object.keys(options.remotes || {}).length === 0
  );
}

function isLocalOnlyContainer(
  options: NormalizedModuleFederationOptions = getNormalizeModuleFederationOptions()
) {
  return (
    Object.keys(options.exposes || {}).length === 0 &&
    Object.keys(options.remotes || {}).length === 0
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

/**
 * Resolution walks from the project root up to the filesystem root, probing
 * every level, and the shared-module resolver asks for the same few packages
 * tens of thousands of times on a cold dev start. The detection cwd is part of
 * the key because `setPackageDetectionCwd` can move it between config hooks.
 */
const concreteSharedImportSourceCache = new Map<string, string | undefined>();

export function resetConcreteSharedImportSourceCache() {
  concreteSharedImportSourceCache.clear();
}

export function getConcreteSharedImportSource(
  pkg: string,
  shareItem?: ShareItem
): string | undefined {
  const configuredImport = shareItem?.shareConfig.import;
  if (typeof configuredImport === 'string') return configuredImport;

  const projectRoot = getPackageDetectionCwd();
  const cacheKey = JSON.stringify([projectRoot, pkg]);
  if (concreteSharedImportSourceCache.has(cacheKey)) {
    return concreteSharedImportSourceCache.get(cacheKey);
  }
  const resolved = resolveConcreteSharedImportSource(pkg, projectRoot);
  concreteSharedImportSourceCache.set(cacheKey, resolved);
  return resolved;
}

function resolveConcreteSharedImportSource(pkg: string, projectRoot: string): string | undefined {
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
export const PREBUILD_TAG = '__prebuild__';

export const TREE_SHAKING_PROVIDER_TAG = '__treeShakingProvider__';
export const TREE_SHAKING_GRAPH_QUERY = '__mf_tree_shaking_graph__';

interface SharedVirtualModuleState {
  preBuildCacheMap: Record<string, VirtualModule>;
  preBuildShareItemMap: Record<string, ShareItem | undefined>;
  treeShakingProviderCacheMap: Record<string, VirtualModule>;
  materializedTreeShakingProviders: Set<string>;
  loadShareCacheMap: Record<string, VirtualModule>;
  warnedMissingImportFalse: Set<string>;
  ownerKey?: string;
}

const legacySharedVirtualModuleState: SharedVirtualModuleState = {
  preBuildCacheMap: {},
  preBuildShareItemMap: {},
  treeShakingProviderCacheMap: {},
  materializedTreeShakingProviders: new Set(),
  loadShareCacheMap: {},
  warnedMissingImportFalse: new Set(),
};
const sharedVirtualModuleStates = new WeakMap<
  NormalizedModuleFederationOptions,
  SharedVirtualModuleState
>();
function getSharedVirtualModuleState(options?: NormalizedModuleFederationOptions) {
  if (!options) {
    try {
      const currentOptions = getNormalizeModuleFederationOptions();
      return sharedVirtualModuleStates.get(currentOptions) ?? legacySharedVirtualModuleState;
    } catch {
      return legacySharedVirtualModuleState;
    }
  }
  let state = sharedVirtualModuleStates.get(options);
  if (!state) {
    state = {
      preBuildCacheMap: {},
      preBuildShareItemMap: {},
      treeShakingProviderCacheMap: {},
      materializedTreeShakingProviders: new Set(),
      loadShareCacheMap: {},
      warnedMissingImportFalse: new Set(),
      ownerKey: getFederationScopeKey(options),
    };
    sharedVirtualModuleStates.set(options, state);
  }
  return state;
}

function createScopedSharedVirtualModule(
  pkg: string,
  tag: string,
  options?: NormalizedModuleFederationOptions
) {
  return new VirtualModule(pkg, tag, '.js', getSharedVirtualModuleState(options).ownerKey);
}

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

function getConcreteTreeShakingExportUsage(
  pkg: string,
  shareItem?: ShareItem,
  options?: NormalizedModuleFederationOptions
) {
  return getTreeShakingExportUsage(pkg, shareItem, shareItem?.name, options);
}

export function getTreeShakingSharedProviderName(
  pkg: string,
  options?: NormalizedModuleFederationOptions
): string {
  const resolvedOptions = options ?? getNormalizeModuleFederationOptions();
  const ownerName = getSharedVirtualModuleState(options).ownerKey;
  return `${ownerName ?? resolvedOptions.internalName ?? resolvedOptions.name}__tree_shaking__${packageNameEncode(pkg)}`;
}

export function getTreeShakingSharedProviderImportId(
  pkg: string,
  options?: NormalizedModuleFederationOptions
): string {
  const { treeShakingProviderCacheMap } = getSharedVirtualModuleState(options);
  if (!treeShakingProviderCacheMap[pkg]) {
    treeShakingProviderCacheMap[pkg] = createScopedSharedVirtualModule(
      pkg,
      TREE_SHAKING_PROVIDER_TAG,
      options
    );
  }
  return treeShakingProviderCacheMap[pkg].getImportId();
}

export function hasTreeShakingSharedProvider(
  pkg: string,
  shareItem?: ShareItem,
  options?: NormalizedModuleFederationOptions
): boolean {
  const { materializedTreeShakingProviders } = getSharedVirtualModuleState(options);
  const usage = getConcreteTreeShakingExportUsage(pkg, shareItem, options);
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
export function writeTreeShakingSharedProvider(
  pkg: string,
  shareItem?: ShareItem,
  options?: NormalizedModuleFederationOptions
): void {
  const { materializedTreeShakingProviders, treeShakingProviderCacheMap } =
    getSharedVirtualModuleState(options);
  const usage = getConcreteTreeShakingExportUsage(pkg, shareItem, options);
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
    (treeShakingProviderCacheMap[pkg] = createScopedSharedVirtualModule(
      pkg,
      TREE_SHAKING_PROVIDER_TAG,
      options
    ));
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

export function writePreBuildLibPath(
  pkg: string,
  shareItem?: ShareItem,
  options?: NormalizedModuleFederationOptions,
  exportConditions?: string[]
) {
  const resolvedOptions = options ?? getNormalizeModuleFederationOptions();
  const { preBuildCacheMap, preBuildShareItemMap } = getSharedVirtualModuleState(options);
  if (!preBuildCacheMap[pkg]) {
    preBuildCacheMap[pkg] = createScopedSharedVirtualModule(pkg, PREBUILD_TAG, options);
  }
  preBuildShareItemMap[pkg] = shareItem;
  const importSource = getConcreteSharedImportSource(pkg, shareItem) || pkg;
  writeTreeShakingSharedProvider(pkg, shareItem, options);
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
    const __mfCacheGlobalKey = ${JSON.stringify(getModuleCacheGlobalKey(exportConditions))};
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
  const namedExports = getSharedNamedExports(pkg, shareItem, exportConditions) ?? [];
  if (namedExports.length > 0) {
    const mutableExports = new Set(
      isLocalOnlyContainer(resolvedOptions)
        ? getSharedMutableExports(pkg, shareItem, exportConditions)
        : []
    );
    const copiedExports = namedExports.filter((name) => !mutableExports.has(name));
    const liveExports = namedExports.filter((name) => mutableExports.has(name));
    const namedExportVars = copiedExports.map((_name, i) => `__mf_${i}`);
    const declarations = copiedExports
      .map(
        (name, i) =>
          `const ${namedExportVars[i]} = __mfPrebuildExports[${escapeGeneratedStringLiteral(name)}];`
      )
      .join('\n    ');
    const namedExportLine = copiedExports.length
      ? `export { ${copiedExports.map((name, i) => `${namedExportVars[i]} as ${name}`).join(', ')} };`
      : '';
    const liveExportLine = liveExports.length
      ? `export { ${liveExports.join(', ')} } from ${escapeGeneratedStringLiteral(importSource)};`
      : '';

    preBuildCacheMap[pkg].writeSync(
      `
    import * as __mfPrebuildNamespace from ${escapeGeneratedStringLiteral(importSource)};
    const __mfPrebuildExports = __mfPrebuildNamespace;
    ${declarations}
    ${namedExportLine}
    ${liveExportLine}
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
export function refreshTreeShakingModules(
  options?: NormalizedModuleFederationOptions,
  command = 'build',
  isRolldown = false,
  exportConditions?: string[]
) {
  const { preBuildShareItemMap } = getSharedVirtualModuleState(options);
  for (const [pkg, shareItem] of Object.entries(preBuildShareItemMap)) {
    if (!shareItem?.shareConfig.treeShaking) continue;
    writePreBuildLibPath(pkg, shareItem, options, exportConditions);
    writeLoadShareModule(pkg, shareItem, command, isRolldown, options, exportConditions);
  }
}
export function getPreBuildLibImportId(
  pkg: string,
  options?: NormalizedModuleFederationOptions
): string {
  const { preBuildCacheMap } = getSharedVirtualModuleState(options);
  if (!preBuildCacheMap[pkg]) {
    preBuildCacheMap[pkg] = createScopedSharedVirtualModule(pkg, PREBUILD_TAG, options);
  }
  const importId = preBuildCacheMap[pkg].getImportId();
  return importId;
}
export function getPreBuildShareItem(
  pkg: string,
  options?: NormalizedModuleFederationOptions
): ShareItem | undefined {
  return getSharedVirtualModuleState(options).preBuildShareItemMap[pkg];
}

export function getSharedImportSource(
  pkg: string,
  shareItem?: ShareItem,
  options?: NormalizedModuleFederationOptions
): string {
  return getConcreteSharedImportSource(pkg, shareItem) || getPreBuildLibImportId(pkg, options);
}

// *** __loadShare__
export const LOAD_SHARE_TAG = '__loadShare__';

export function getLoadShareImportId(
  pkg: string,
  _isRolldown: boolean,
  options?: NormalizedModuleFederationOptions
): string {
  const { loadShareCacheMap } = getSharedVirtualModuleState(options);
  if (!loadShareCacheMap[pkg]) {
    loadShareCacheMap[pkg] = createScopedSharedVirtualModule(pkg, LOAD_SHARE_TAG, options);
  }
  return loadShareCacheMap[pkg].getImportId();
}
export function getLoadShareModulePath(
  pkg: string,
  isRolldown: boolean,
  options?: NormalizedModuleFederationOptions
): string {
  const { loadShareCacheMap } = getSharedVirtualModuleState(options);
  if (!loadShareCacheMap[pkg]) getLoadShareImportId(pkg, isRolldown, options);
  const filepath = loadShareCacheMap[pkg].getImportId();
  return filepath;
}

function getCachedSharedVirtualPkg(id: string, tag: string): string | undefined {
  // Most resolved ids are not shared virtual ids. Fast reject before
  // normalization/decoding work on the resolveId hot path.
  if (!id.includes(tag)) return;
  const normalized = normalizeVirtualModuleId(id);
  if (!normalized.startsWith('virtual:mf:')) return;

  const start = normalized.indexOf(tag);
  if (start === -1) return;

  const encodedPkgStart = start + tag.length;
  const end = normalized.indexOf(tag, encodedPkgStart);
  if (end === -1) return;

  return packageNameDecode(normalized.slice(encodedPkgStart, end));
}

export function getCachedPreBuildPkg(id: string): string | undefined {
  return getCachedSharedVirtualPkg(id, PREBUILD_TAG);
}

export function getCachedLoadSharePkg(id: string): string | undefined {
  return getCachedSharedVirtualPkg(id, LOAD_SHARE_TAG);
}

export function materializeCachedLoadShareModule(options: {
  id: string;
  shared: NormalizedShared;
  command: string;
  isRolldown: boolean;
  findSharedKey: (source: string, shared: NormalizedShared) => string | undefined;
  addUsedShares: (pkg: string) => void;
  writeLocalSharedImportMap: () => void;
  federationOptions?: NormalizedModuleFederationOptions;
}): void {
  const pkg = getCachedLoadSharePkg(options.id);
  if (!pkg) return;
  const key = options.findSharedKey(pkg, options.shared);
  if (!key) return;

  const shareItem = options.shared[key];
  writeLoadShareModule(
    pkg,
    shareItem,
    options.command,
    options.isRolldown,
    options.federationOptions
  );
  if (shareItem.shareConfig?.import !== false) {
    writePreBuildLibPath(pkg, shareItem, options.federationOptions);
  }
  options.addUsedShares(pkg);
  options.writeLocalSharedImportMap();
}

// Owner keys embed a process-wide generation counter, so a loadShare id is
// only resolvable in the process (and config generation) that minted it. But
// Vite's dependency optimizer persists these ids inside node_modules/.vite:
// a config re-evaluation or a fresh dev-server process mints new generations,
// and cached deps referencing the old owner would fail to resolve until the
// cache is deleted. When a stale id was minted by an earlier generation
// of THIS instance, redirect it to the current generation's module instead.
export function findCurrentLoadShareForStaleOwnerId(
  id: string,
  shared: NormalizedShared,
  findSharedKey: (source: string, shared: NormalizedShared) => string | undefined,
  options: NormalizedModuleFederationOptions
): VirtualModule | undefined {
  const pkg = getCachedLoadSharePkg(id);
  if (!pkg) return;
  const normalized = normalizeVirtualModuleId(id);
  if (!normalized.startsWith('virtual:mf:')) return;
  const encodedKey = normalized.slice('virtual:mf:'.length);
  const ownerStart = encodedKey.indexOf(MF_OWNER_INFIX);
  if (ownerStart === -1) return;
  // Owner keys are scoped per federation instance; only reclaim ids this
  // instance minted. Other instances' resolveId hooks handle their own.
  if (encodedKey.slice(0, ownerStart) !== packageNameEncode(options.internalName)) return;
  if (!findSharedKey(pkg, shared)) return;
  return getSharedVirtualModuleState(options).loadShareCacheMap[pkg];
}

function getSharedCacheReadExpression(cacheDescriptor: string, treeShakingConsumer?: string) {
  return treeShakingConsumer
    ? `__mfReadTreeShakingSharedSelection(__mfModuleCache.share, ${cacheDescriptor}, ${JSON.stringify(treeShakingConsumer)})`
    : `__mfReadSharedCache(__mfModuleCache.share, ${cacheDescriptor})`;
}

/**
 * Eager workspace singleton wrapper: reads the shared cache synchronously and falls back to the local
 * namespace. Inside the fallback's own evaluation cycle that namespace is not initialized yet (undefined in
 * a merged chunk, TDZ bindings otherwise), so the exports stay unassigned until the deferred cache write
 * re-applies them; a host-provided copy re-applies them through the cache subscription as before.
 */
function generateEagerWorkspaceSingletonExports(
  namedExports: string[],
  importSource: string,
  cacheDescriptor: string,
  cacheOwner: string,
  treeShakingConsumer?: string,
  mutableExports: string[] = []
) {
  const copiedExports = namedExports.filter((name) => !mutableExports.includes(name));
  const namedExportVars = copiedExports.map((_name, i) => `__mf_${i}`);
  const declarations =
    namedExports.length > 0
      ? ['let __mf_default;', ...namedExportVars.map((name) => `let ${name};`)].join('\n    ')
      : 'let __mf_default;';
  const assignments = [
    ...copiedExports.map(
      (name, i) => `${namedExportVars[i]} = mod[${escapeGeneratedStringLiteral(name)}];`
    ),
    '__mf_default = mod.default ?? mod;',
  ].join('\n      ');
  const namedExportLine =
    copiedExports.length > 0
      ? `\n    export { ${copiedExports.map((name, i) => `${namedExportVars[i]} as ${name}`).join(', ')} };`
      : '';
  const mutableExportLine = mutableExports.length
    ? `\n    export { ${mutableExports.join(', ')} } from ${escapeGeneratedStringLiteral(importSource)};`
    : '';

  return `import * as __mfLocalShare from ${escapeGeneratedStringLiteral(importSource)};
    let exportModule = ${getSharedCacheReadExpression(cacheDescriptor, treeShakingConsumer)};
    if (exportModule === undefined) {
      Promise.resolve().then(() => {
        if (__mfReadSharedCache(__mfModuleCache.share, ${cacheDescriptor}) !== undefined) return;
        const localShare = __mfInitializedLocalShare(__mfLocalShare);
        if (localShare !== undefined) {
          __mfWriteSharedCache(__mfModuleCache.share, ${cacheDescriptor}, localShare, ${cacheOwner});
        }
      });
      exportModule = __mfLocalShare;
    }
    ${declarations}
    const __mfApplyEagerShareExports = (mod) => {
      ${assignments}
    };
    const __mfApplyEagerShareExportsWhenReady = (mod) => {
      if (mod === undefined) return;
      try {
        __mfApplyEagerShareExports(mod);
      } catch (error) {
        if (!(error instanceof ReferenceError)) throw error;
      }
    };
    __mfSubscribeSharedCache(__mfModuleCache.share, ${cacheDescriptor}, __mfApplyEagerShareExports);
    __mfApplyEagerShareExportsWhenReady(exportModule);
    export { __mf_default as default };${namedExportLine}${mutableExportLine}`;
}
function generateLazyWorkspaceSingletonExports(
  namedExports: string[],
  importSource: string,
  cacheDescriptor: string,
  cacheOwner: string,
  treeShakingConsumer?: string,
  serveLocalFallback = false,
  mutableExports: string[] = []
) {
  const copiedExports = namedExports.filter((name) => !mutableExports.includes(name));
  const namedExportVars = copiedExports.map((_name, i) => `__mf_${i}`);
  const declarations =
    namedExports.length > 0
      ? ['let __mf_default;', ...namedExportVars.map((name) => `let ${name};`)].join('\n    ')
      : 'let __mf_default;';
  const assignments =
    copiedExports.length > 0
      ? [
          ...copiedExports.map(
            (name, i) => `${namedExportVars[i]} = mod[${escapeGeneratedStringLiteral(name)}];`
          ),
          '__mf_default = mod.default ?? mod;',
        ].join('\n      ')
      : '__mf_default = mod.default ?? mod;';
  const namedExportLine =
    copiedExports.length > 0
      ? `\n    export { ${copiedExports.map((name, i) => `${namedExportVars[i]} as ${name}`).join(', ')} };`
      : '';
  const mutableExportLine = mutableExports.length
    ? `\n    export { ${mutableExports.join(', ')} } from ${escapeGeneratedStringLiteral(importSource)};`
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
        __mfTrackPendingShareLoad(initPromise.then(() => {
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
    export { __mf_default as default };${namedExportLine}${mutableExportLine}`;

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
      __mfTrackPendingShareLoad(initPromise.then(() => {
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

function selectImportFalseNamedExports(
  detectedNamedExports: string[] | undefined,
  usage?: TreeShakingExportUsage
) {
  if (!detectedNamedExports || usage?.kind !== 'exports') {
    return detectedNamedExports ?? [];
  }

  const usedNamedExports = new Set(usage.usedExports.filter((name) => name !== 'default'));
  if ([...usedNamedExports].some((name) => !detectedNamedExports.includes(name))) {
    return detectedNamedExports;
  }
  return detectedNamedExports.filter((name) => usedNamedExports.has(name));
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
const initializedLocalShareModuleCode = `const __mfInitializedLocalShare = (mod) => {
      if (mod === undefined) return undefined;
      try {
        return __mfNormalizeShareModule(mod);
      } catch (error) {
        if (error instanceof ReferenceError) return undefined;
        throw error;
      }
    };`;

export function writeLoadShareModule(
  pkg: string,
  shareItem: ShareItem,
  command: string,
  _isRolldown: boolean,
  options?: NormalizedModuleFederationOptions,
  exportConditions?: string[],
  importFalseExportUsage?: TreeShakingExportUsage
) {
  const resolvedOptions = options ?? getNormalizeModuleFederationOptions();
  const { loadShareCacheMap } = getSharedVirtualModuleState(options);
  if (!loadShareCacheMap[pkg]) {
    loadShareCacheMap[pkg] = createScopedSharedVirtualModule(pkg, LOAD_SHARE_TAG, options);
  }
  let importLine = getRuntimeModuleCacheBootstrapCode(exportConditions);
  const cacheDescriptor = getSharedCacheDescriptorLiteral(pkg, shareItem);
  const cacheOwner = JSON.stringify(resolvedOptions.name);
  const runtimeInitOwnerImportId = options ? getRuntimeInitStatusImportId(options) : undefined;
  const treeShakingConsumer =
    command === 'build' && shareItem.shareConfig.treeShaking ? resolvedOptions.name : undefined;

  // import: false means the host must provide this module — the remote has no local copy.
  // Generate a minimal loadShare module that just delegates to the runtime.
  // No prebuild imports, no dev warming imports.
  if (shareItem.shareConfig.import === false) {
    // Try to detect named exports from locally installed devDependencies.
    // This enables `import { ref } from 'vue'` even though the module is provided by the host.
    // For packages that aren't installed, fall back to default-only export.
    const detectedNamedExports = getPackageNamedExports(pkg, exportConditions);
    const namedExports = selectImportFalseNamedExports(
      detectedNamedExports,
      importFalseExportUsage
    );
    let exportLine: string;
    if (namedExports.length > 0) {
      exportLine = generateDeferredHostProvidedExports(
        namedExports,
        pkg,
        cacheDescriptor,
        treeShakingConsumer
      );
    } else {
      const { warnedMissingImportFalse } = getSharedVirtualModuleState(resolvedOptions);
      if (
        detectedNamedExports === undefined &&
        !shareItem.shareConfig.suppressMissingImportWarning &&
        !warnedMissingImportFalse.has(pkg)
      ) {
        warnedMissingImportFalse.add(pkg);
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
    ${getRuntimeInitPromiseBootstrapCode(false, runtimeInitOwnerImportId)}
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
  const sharedImportSource = concreteSharedImportSource || getPreBuildLibImportId(pkg, options);
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
  const detectedNamedExports = getSharedNamedExports(pkg, shareItem, exportConditions);
  const namedExports = detectedNamedExports ?? [];
  const mutableExports = new Set(
    isLocalOnlyContainer(resolvedOptions)
      ? getSharedMutableExports(pkg, shareItem, exportConditions)
      : []
  );
  const copiedNamedExports = namedExports.filter((name) => !mutableExports.has(name));
  const liveNamedExports = namedExports.filter((name) => mutableExports.has(name));
  const liveNamedExportLine = liveNamedExports.length
    ? `export { ${liveNamedExports.join(', ')} } from ${escapeGeneratedStringLiteral(sharedImportSource)};`
    : '';
  const hasCompleteExportCoverage = detectedNamedExports !== undefined;
  const isWorkspaceSingleton = isWorkspacePackage && shareItem.shareConfig.singleton === true;
  const isDefaultShareScope =
    shareItem.scope === undefined ||
    shareItem.scope === 'default' ||
    (Array.isArray(shareItem.scope) && shareItem.scope[0] === 'default');
  const usesDeferredSingletonFallback =
    hasCompleteExportCoverage &&
    shareItem.shareConfig.eager !== true &&
    (isWorkspacePackage ||
      (command !== 'build' &&
        isRemoteOnlyContainer(resolvedOptions) &&
        shareItem.shareConfig.singleton === true) ||
      (command === 'build' &&
        isRemoteOnlyContainer(resolvedOptions) &&
        (shareItem.shareConfig.singleton === true || isDefaultShareScope) &&
        !isSharedSingletonConsumedByPeer(pkg, resolvedOptions, true)));
  const servesRemoteSingletonFallback =
    command !== 'build' &&
    isRemoteOnlyContainer(resolvedOptions) &&
    shareItem.shareConfig.singleton === true;
  const isConsumedByPeerSingleton = isSharedSingletonConsumedByPeer(pkg, resolvedOptions);
  const usesEntryInjectedRemoteFallback =
    hasCompleteExportCoverage &&
    !isWorkspaceSingleton &&
    isRemoteOnlyContainer(resolvedOptions) &&
    shareItem.shareConfig.singleton === true &&
    resolvedOptions.hostInitInjectLocation === 'entry' &&
    (command === 'build' || isConsumedByPeerSingleton);
  const usesEagerWorkspaceFallback =
    hasCompleteExportCoverage &&
    isWorkspaceSingleton &&
    !servesRemoteSingletonFallback &&
    (isConsumedByPeerSingleton || shareItem.shareConfig.eager === true);
  const usesDeferredTreeShakingFallback = hasCompleteExportCoverage && Boolean(treeShakingConsumer);
  const reactMixedModeGuard = pkg === 'react' ? createReactMixedModeRuntimeGuard() : '';
  let exportLine: string;
  let initBlock = '';
  if (usesDeferredTreeShakingFallback) {
    importLine = `${getRuntimeInitPromiseBootstrapCode(false, runtimeInitOwnerImportId)}\n    ${importLine}`;
    exportLine = generateLazyWorkspaceSingletonExports(
      namedExports,
      lazyLocalFallbackSource,
      cacheDescriptor,
      cacheOwner,
      treeShakingConsumer,
      command !== 'build' &&
        !servesRemoteSingletonFallback &&
        (isWorkspaceSingleton || isWorkspacePackage),
      liveNamedExports
    );
  } else if (usesEagerWorkspaceFallback || usesEntryInjectedRemoteFallback) {
    exportLine = generateEagerWorkspaceSingletonExports(
      namedExports,
      lazyLocalFallbackSource,
      cacheDescriptor,
      cacheOwner,
      treeShakingConsumer,
      liveNamedExports
    );
  } else if (usesDeferredSingletonFallback) {
    importLine = `${getRuntimeInitPromiseBootstrapCode(false, runtimeInitOwnerImportId)}\n    ${importLine}`;
    exportLine = generateLazyWorkspaceSingletonExports(
      namedExports,
      lazyLocalFallbackSource,
      cacheDescriptor,
      cacheOwner,
      treeShakingConsumer,
      command !== 'build' &&
        !servesRemoteSingletonFallback &&
        (isWorkspaceSingleton || isWorkspacePackage),
      liveNamedExports
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
    const namedExportVars = copiedNamedExports.map((_name, i) => `__mf_${i}`);
    const declarations = [
      'let __mfDefaultExport;',
      ...namedExportVars.map((name) => `let ${name};`),
    ].join('\n    ');
    const assignments = [
      ...(reactMixedModeGuard ? [reactMixedModeGuard] : []),
      ...copiedNamedExports.map(
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
    const namedExportLine = copiedNamedExports.length
      ? `export { ${copiedNamedExports.map((name, i) => `__mf_${i} as ${name}`).join(', ')} };`
      : '';
    exportLine = `${declarations}
    const __mfApplySharedExports = (mod) => {
      ${assignments}
    };
    __mfSubscribeSharedCache(__mfModuleCache.share, ${cacheDescriptor}, __mfApplySharedExports);
    __mfApplySharedExports(exportModule);
    export { __mfDefaultExport as default };
    ${namedExportLine}
    ${liveNamedExportLine}`;
    initBlock = `exportModule = __mfNormalizeShareModule(__mfLocalShare);
      __mfWriteSharedCache(__mfModuleCache.share, ${cacheDescriptor}, exportModule, ${cacheOwner});`;
  } else if (namedExports.length > 0) {
    const destructure = copiedNamedExports.length
      ? `const { ${copiedNamedExports.map((name, i) => `${name}: __mf_${i}`).join(', ')} } = exportModule;`
      : '';
    const namedExportLine = copiedNamedExports.length
      ? `export { ${copiedNamedExports.map((name, i) => `__mf_${i} as ${name}`).join(', ')} };`
      : '';
    exportLine = `const __mfDefaultExport = (() => {
      ${generateShareModuleUnwrapCode({
        source: 'exportModule',
        preserveNamedExports: false,
        stopWithReturn: 'defaultExport ?? current',
      })}
    })();
    export default __mfDefaultExport;
    ${destructure}
    ${namedExportLine}
    ${liveNamedExportLine}`;
    initBlock = `exportModule = __mfNormalizeShareModule(__mfLocalShare);
      __mfWriteSharedCache(__mfModuleCache.share, ${cacheDescriptor}, exportModule, ${cacheOwner});`;
  } else if (shareItem.shareConfig.singleton === true) {
    exportLine = `let __mfDefaultExport;
    const __mfApplySharedDefaultExport = (mod) => {
      ${reactMixedModeGuard}
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
        ? !servesRemoteSingletonFallback &&
          usesDeferredSingletonFallback &&
          command !== 'build' &&
          (isWorkspaceSingleton || isWorkspacePackage)
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

  // These export blocks declare `exportModule` themselves; the plain body must not declare it a second time.
  const exportLineDeclaresModule =
    usesDeferredSingletonFallback ||
    usesDeferredTreeShakingFallback ||
    usesEagerWorkspaceFallback ||
    usesEntryInjectedRemoteFallback;
  const moduleBody = exportLineDeclaresModule
    ? `
    ${prebuildImportLine}
    ${devDynamicImportLine}
    ${importLine}
    ${sharedCacheHelperCode}
    ${normalizeLocalShareModuleCode}
    ${initializedLocalShareModuleCode}
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

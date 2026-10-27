import { existsSync, readFileSync, statSync } from 'fs';
import * as path from 'node:path';
import type { ShareItem } from './normalizeModuleFederationOptions';
import { getInstalledPackageJson, getPackageDetectionCwd, getPackageName } from './packageUtils';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts'];

function isFile(filePath: string) {
  return existsSync(filePath) && !statSync(filePath).isDirectory();
}

function resolveSourceFile(filePath: string): string | undefined {
  if (isFile(filePath)) return filePath;
  for (const ext of SOURCE_EXTENSIONS) {
    if (isFile(filePath + ext)) return filePath + ext;
  }
  // TypeScript sources import the emitted extension ('./slice.js') while the file is 'slice.ts'.
  const withoutExtension = filePath.replace(/\.(?:m?js|jsx)$/, '');
  if (withoutExtension !== filePath) {
    for (const ext of SOURCE_EXTENSIONS) {
      if (isFile(withoutExtension + ext)) return withoutExtension + ext;
    }
  }
  for (const ext of SOURCE_EXTENSIONS) {
    const index = path.join(filePath, 'index' + ext);
    if (isFile(index)) return index;
  }
  return undefined;
}

/**
 * The source file of a share whose `import` points at a project file rather than an installed
 * package, such as an application module shared with its micro frontends. Installed packages
 * describe their dependencies in `package.json`, so a path import of an installed package (a shim)
 * is not local. Undefined when the file cannot be found.
 */
export function getLocalShareSourceFile(
  pkg: string,
  shareItem: ShareItem | undefined
): string | undefined {
  const importSource = shareItem?.shareConfig?.import;
  if (typeof importSource !== 'string') return undefined;
  const relative = importSource.startsWith('.');
  if (!relative && !path.isAbsolute(importSource)) return undefined;
  if (getInstalledPackageJson(getPackageName(pkg)) !== undefined) return undefined;
  return resolveSourceFile(
    relative ? path.resolve(getPackageDetectionCwd(), importSource) : importSource
  );
}

const STATIC_IMPORT_RE =
  /\b(?:import|export)\b(?!\s*\()[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g;

/** Specifiers of the static imports and re-exports in `code`; dynamic and type-only imports are skipped. */
export function getStaticImportSpecifiers(code: string): string[] {
  const source = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  const specifiers = new Set<string>();
  for (const match of source.matchAll(STATIC_IMPORT_RE)) {
    if (/^(?:import|export)\s+type\b/.test(match[0])) continue;
    specifiers.add(match[1] ?? match[2]);
  }
  return [...specifiers];
}

const specifiersByFile = new Map<string, { mtimeMs: number; specifiers: string[] }>();

/** `getStaticImportSpecifiers` of a file, cached until the file changes; empty when it cannot be read. */
function readStaticImportSpecifiers(file: string): string[] {
  try {
    const { mtimeMs } = statSync(file);
    const cached = specifiersByFile.get(file);
    if (cached && cached.mtimeMs === mtimeMs) return cached.specifiers;
    const specifiers = getStaticImportSpecifiers(readFileSync(file, 'utf-8'));
    specifiersByFile.set(file, { mtimeMs, specifiers });
    return specifiers;
  } catch {
    return [];
  }
}

/**
 * Keys of the other local shares that `sourceFile` imports at evaluation time, by key (or request)
 * or by source file, directly or through relative imports of project files that are not shared.
 * `localShareFiles` maps each local share's key to its source file; `requests` maps a share's
 * request to its key when they differ.
 */
export function getImportedLocalShares(
  sourceFile: string,
  localShareFiles: Map<string, string>,
  requests: Map<string, string> = new Map()
): string[] {
  const keysByFile = new Map(Array.from(localShareFiles, ([key, file]) => [file, key]));
  const imported = new Set<string>();
  const visited = new Set<string>();
  const visit = (file: string) => {
    if (visited.has(file)) return;
    visited.add(file);
    for (const specifier of readStaticImportSpecifiers(file)) {
      if (specifier.startsWith('.')) {
        const resolved = resolveSourceFile(path.resolve(path.dirname(file), specifier));
        if (!resolved || resolved.split(path.sep).includes('node_modules')) continue;
        const key = keysByFile.get(resolved);
        if (key !== undefined) imported.add(key);
        else visit(resolved);
      } else {
        const key = localShareFiles.has(specifier) ? specifier : requests.get(specifier);
        if (key !== undefined) imported.add(key);
      }
    }
  };
  visit(sourceFile);
  const self = keysByFile.get(sourceFile);
  if (self !== undefined) imported.delete(self);
  return [...imported];
}

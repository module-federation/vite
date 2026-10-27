import { readFileSync, statSync } from 'fs';
import * as path from 'node:path';
import {
  resolveConfiguredImportPath,
  resolveRelativeModule,
} from '../virtualModules/virtualShared_preBuild';
import { findModuleImportDescriptors } from './htmlEntryUtils';
import type { ShareItem } from './normalizeModuleFederationOptions';
import { getInstalledPackageJson, getPackageName } from './packageUtils';

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
  if (!importSource.startsWith('.') && !path.isAbsolute(importSource)) return undefined;
  if (getInstalledPackageJson(getPackageName(pkg)) !== undefined) return undefined;
  return resolveConfiguredImportPath(importSource);
}

const specifiersByFile = new Map<string, { mtimeMs: number; specifiers: string[] }>();

/** Specifiers a file evaluates (static, not type-only), cached until the file changes; empty when it cannot be read. */
function readStaticImportSpecifiers(file: string): string[] {
  try {
    const { mtimeMs } = statSync(file);
    const cached = specifiersByFile.get(file);
    if (cached && cached.mtimeMs === mtimeMs) return cached.specifiers;
    const specifiers = findModuleImportDescriptors(readFileSync(file, 'utf-8'))
      .filter(({ kind, typeOnly }) => kind === 'static' && !typeOnly)
      .map(({ source }) => source);
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
        const resolved = resolveRelativeModule(file, specifier);
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

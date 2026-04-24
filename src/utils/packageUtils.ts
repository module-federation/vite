import { existsSync, readFileSync, readdirSync } from 'fs';
import { createRequire } from 'module';
import path from 'pathe';
import { createModuleFederationError } from './logger';

type PackageJsonDependencyGroups = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const dependencyPresenceCache = new Map<string, boolean>();
let packageDetectionCwd: string | undefined;

function getDependencyCacheKey(cwd: string, dependencyName: string) {
  return `${cwd}:${dependencyName}`;
}

export function setPackageDetectionCwd(cwd: string) {
  packageDetectionCwd = cwd;
}

export function getPackageDetectionCwd() {
  return packageDetectionCwd || process.cwd();
}

export type InstalledPackageJson = {
  path: string;
  dir: string;
  packageJson: Record<string, unknown>;
};

type PackageEntryConditions = {
  cwd?: string;
  packageName?: string;
  conditions?: string[];
  resolveSubpathWithRequire?: boolean;
  fromResolvedEntry?: string;
};

const DEFAULT_EXPORT_CONDITIONS = ['browser', 'import', 'module', 'default', 'require'];

function resolveExportsEntry(
  exportsField: unknown,
  conditions = DEFAULT_EXPORT_CONDITIONS
): string | undefined {
  if (typeof exportsField === 'string') return exportsField;
  if (!exportsField || typeof exportsField !== 'object') return undefined;
  const record = exportsField as Record<string, unknown>;
  const rootExport = record['.'];
  if (rootExport) return resolveExportsEntry(rootExport);

  for (const condition of conditions) {
    const target = resolveExportsEntry(record[condition], conditions);
    if (target) return target;
  }

  for (const target of Object.values(record)) {
    const resolved = resolveExportsEntry(target, conditions);
    if (resolved) return resolved;
  }

  return undefined;
}

function getPackageExportsTarget(pkg: string, packageName: string, exportsField: unknown): unknown {
  if (typeof exportsField === 'string') return pkg === packageName ? exportsField : undefined;
  if (!exportsField || typeof exportsField !== 'object') return undefined;

  const record = exportsField as Record<string, unknown>;
  const subpath = pkg === packageName ? '.' : `.${pkg.slice(packageName.length)}`;
  if (subpath !== '.') return record[subpath];

  return (
    record['.'] ?? (!Object.keys(record).some((key) => key.startsWith('.')) ? record : undefined)
  );
}
/**
 * Escaping rules:
 * Convert using the format __${mapping}__, where _ and $ are not allowed in npm package names but can be used in variable names.
 *  @ => 1
 *  / => 2
 *  - => 3
 *  . => 4
 */

/**
 * Encodes a package name into a valid file name.
 * @param {string} name - The package name, e.g., "@scope/xx-xx.xx".
 * @returns {string} - The encoded file name.
 */
export function packageNameEncode(name: string) {
  if (typeof name !== 'string') {
    throw createModuleFederationError('A string package name is required');
  }
  return name
    .replace(/@/g, '_mf_0_')
    .replace(/\//g, '_mf_1_')
    .replace(/-/g, '_mf_2_')
    .replace(/\./g, '_mf_3_');
}

/**
 * Decodes an encoded file name back to the original package name.
 * @param {string} encoded - The encoded file name, e.g., "_mf_0_scope_mf_1_xx_mf_2_xx_mf_3_xx".
 * @returns {string} - The decoded package name.
 */
export function packageNameDecode(encoded: string) {
  if (typeof encoded !== 'string') {
    throw createModuleFederationError('A string encoded file name is required');
  }
  return encoded
    .replace(/_mf_0_/g, '@')
    .replace(/_mf_1_/g, '/')
    .replace(/_mf_2_/g, '-')
    .replace(/_mf_3_/g, '.');
}

/**
 * Removes any subpath from an npm package specifier and returns the package name only.
 * @param {string} packageString - The package specifier, e.g., "@scope/pkg/runtime" or "react/jsx-runtime".
 * @returns {string} - The base npm package name.
 */
export function getPackageName(packageString: string): string {
  const regex = /^(?:@[^/]+\/)?[^/]+/;
  const match = packageString.match(regex);
  return match ? match[0] : packageString;
}

export function getInstalledPackageJson(
  pkg: string,
  opts?: PackageEntryConditions
): InstalledPackageJson | undefined {
  const cwd = opts?.cwd || getPackageDetectionCwd();
  const packageName = opts?.packageName || getPackageName(pkg);
  const tryReadPackageJson = (packageJsonPath: string): InstalledPackageJson | undefined => {
    if (!existsSync(packageJsonPath)) return undefined;
    try {
      return {
        path: packageJsonPath,
        dir: path.dirname(packageJsonPath),
        packageJson: JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as Record<string, unknown>,
      };
    } catch {
      return undefined;
    }
  };
  const findPackageInPnpmStore = (startDir: string): InstalledPackageJson | undefined => {
    let currentDir = startDir;
    const rootDir = path.parse(currentDir).root;

    while (true) {
      const pnpmStoreDir = path.join(currentDir, 'node_modules', '.pnpm');
      if (existsSync(pnpmStoreDir)) {
        try {
          for (const entry of readdirSync(pnpmStoreDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const candidate = tryReadPackageJson(
              path.join(pnpmStoreDir, entry.name, 'node_modules', packageName, 'package.json')
            );
            if (candidate?.packageJson.name === packageName) return candidate;
          }
        } catch {}
      }
      if (currentDir === rootDir) break;
      currentDir = path.dirname(currentDir);
    }
  };

  try {
    const projectRequire = createRequire(new URL(`file://${path.join(cwd, 'package.json')}`));
    let resolvedPath: string | undefined;

    if (opts?.fromResolvedEntry) {
      resolvedPath = opts.fromResolvedEntry;
    } else {
      try {
        resolvedPath = projectRequire.resolve(pkg);
      } catch {
        resolvedPath = projectRequire.resolve(packageName);
      }
    }

    let currentDir = path.dirname(resolvedPath);
    const rootDir = path.parse(currentDir).root;

    while (true) {
      const packageJsonPath = path.join(currentDir, 'package.json');
      if (existsSync(packageJsonPath)) {
        const packageJsonContent = readFileSync(packageJsonPath, 'utf-8');
        try {
          const packageJson = JSON.parse(packageJsonContent) as Record<string, unknown>;
          if (packageJson.name === packageName) {
            return {
              path: packageJsonPath,
              dir: currentDir,
              packageJson,
            };
          }
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
      }
      if (currentDir === rootDir) break;
      currentDir = path.dirname(currentDir);
    }
  } catch {
    let currentDir = cwd;
    const rootDir = path.parse(currentDir).root;

    while (true) {
      const packageJsonPath = path.join(currentDir, 'node_modules', packageName, 'package.json');
      const directCandidate = tryReadPackageJson(packageJsonPath);
      if (directCandidate?.packageJson.name === packageName) return directCandidate;
      if (currentDir === rootDir) break;
      currentDir = path.dirname(currentDir);
    }

    return findPackageInPnpmStore(cwd);
  }

  return undefined;
}

export function getInstalledPackageEntry(
  pkg: string,
  opts?: PackageEntryConditions
): string | undefined {
  const installed = getInstalledPackageJson(pkg, opts);
  if (!installed) return undefined;
  const cwd = opts?.cwd || getPackageDetectionCwd();
  const packageName = opts?.packageName || getPackageName(pkg);
  if (pkg !== packageName && opts?.resolveSubpathWithRequire !== false) {
    try {
      const projectRequire = createRequire(new URL(`file://${path.join(cwd, 'package.json')}`));
      return projectRequire.resolve(pkg);
    } catch {
      // Fall back to root package entry resolution below.
    }
  }
  const packageJson = installed.packageJson;
  const exportsEntry = resolveExportsEntry(
    getPackageExportsTarget(pkg, packageName, packageJson.exports),
    opts?.conditions
  );
  const explicitEntry =
    exportsEntry ||
    (typeof packageJson.module === 'string' ? packageJson.module : undefined) ||
    (typeof packageJson.main === 'string' ? packageJson.main : undefined) ||
    'index.js';
  return path.join(installed.dir, explicitEntry);
}

/**
 * Extracts the file extension from the subpath portion of an npm package specifier.
 * @param {string} packageString - The package specifier, e.g., "@scope/pkg/file.js".
 * @returns {string | undefined} - The extension including the dot, or `undefined` when none is present.
 */
export function getExtFromNpmPackage(packageString: string) {
  const pkgName = getPackageName(packageString);
  const subpath = packageString.replace(pkgName, '');
  const parts = subpath.split('.');
  const ext = parts.length > 1 ? '.' + parts.pop() : undefined;
  return ext;
}

/**
 * Detect whether the current runtime is Vite 8+ by checking for a Vite version flag
 * on the plugin hook context, with Rolldown metadata kept as a compatibility fallback.
 */
export function getIsRolldown(ctx: unknown): boolean {
  const viteVersion = (ctx as any)?.meta?.viteVersion;
  const viteMajor = Number(String(viteVersion ?? '').split('.')[0]);
  return (Number.isFinite(viteMajor) && viteMajor >= 8) || !!(ctx as any)?.meta?.rolldownVersion;
}

export function hasPackageDependency(
  dependencyName: string,
  cwd = packageDetectionCwd || process.cwd()
): boolean {
  const cacheKey = getDependencyCacheKey(cwd, dependencyName);
  const cached = dependencyPresenceCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const packageJson = JSON.parse(
      readFileSync(path.join(cwd, 'package.json'), 'utf8')
    ) as PackageJsonDependencyGroups;

    const hasDependency = [
      packageJson.dependencies,
      packageJson.devDependencies,
      packageJson.peerDependencies,
      packageJson.optionalDependencies,
    ].some((deps) => !!deps?.[dependencyName]);

    dependencyPresenceCache.set(cacheKey, hasDependency);
    return hasDependency;
  } catch {
    dependencyPresenceCache.set(cacheKey, false);
    return false;
  }
}

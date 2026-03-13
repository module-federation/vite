import { readFileSync } from 'fs';
import path from 'pathe';

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
  if (typeof name !== 'string') throw new Error('A string package name is required');
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
  if (typeof encoded !== 'string') throw new Error('A string encoded file name is required');
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
export function removePathFromNpmPackage(packageString: string): string {
  const regex = /^(?:@[^/]+\/)?[^/]+/;
  const match = packageString.match(regex);
  return match ? match[0] : packageString;
}

/**
 * Extracts the file extension from the subpath portion of an npm package specifier.
 * @param {string} packageString - The package specifier, e.g., "@scope/pkg/file.js".
 * @returns {string | undefined} - The extension including the dot, or `undefined` when none is present.
 */
export function getExtFromNpmPackage(packageString: string) {
  const pkgName = removePathFromNpmPackage(packageString);
  const subpath = packageString.replace(pkgName, '');
  const parts = subpath.split('.');
  const ext = parts.length > 1 ? '.' + parts.pop() : undefined;
  return ext;
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

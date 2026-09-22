import { existsSync, readFileSync, readdirSync } from 'fs';
import { createRequire } from 'module';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createModuleFederationError } from './logger';
import type { ShareItem } from './normalizeModuleFederationOptions';
import { getNodeModulesSuffix } from './pathNormalization';

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

// getInstalledPackageJson's fallback path can scan every entry in
// node_modules/.pnpm (thousands in a real monorepo) with synchronous fs
// calls. It's invoked repeatedly for the same specifier from resolveId
// hooks during dev serving, so cache results for the process lifetime the
// same way hasPackageDependency already does above.
const installedPackageJsonCache = new Map<string, InstalledPackageJson | undefined>();

export function setPackageDetectionCwd(cwd: string) {
  packageDetectionCwd = cwd;
}

export function getPackageDetectionCwd() {
  return packageDetectionCwd || process.cwd();
}

export function resolveImportPath(specifier: string): string {
  const resolved = import.meta.resolve(specifier);
  if (!resolved.startsWith('file:')) return resolved;

  const filePath = fileURLToPath(resolved);
  if (!existsSync(filePath)) {
    const error = new Error(`Cannot find module '${specifier}'`) as NodeJS.ErrnoException;
    error.code = 'MODULE_NOT_FOUND';
    throw error;
  }
  return filePath;
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

const DEFAULT_EXPORT_CONDITIONS = ['browser', 'import', 'module', 'default'];

function resolveExportsEntry(
  exportsField: unknown,
  conditions = DEFAULT_EXPORT_CONDITIONS
): string | undefined {
  return resolveExportsEntryWithConditions(exportsField, new Set(conditions));
}

function resolveExportsEntryWithConditions(
  exportsField: unknown,
  conditions: ReadonlySet<string>
): string | undefined {
  if (typeof exportsField === 'string') return exportsField;
  if (!exportsField || typeof exportsField !== 'object') return undefined;

  if (Array.isArray(exportsField)) {
    for (const target of exportsField) {
      const resolved = resolveExportsEntryWithConditions(target, conditions);
      if (resolved) return resolved;
    }
    return undefined;
  }

  const record = exportsField as Record<string, unknown>;
  const rootExport = record['.'];
  if (rootExport) return resolveExportsEntryWithConditions(rootExport, conditions);

  // Conditional exports are matched in package.json key order. Conditions
  // identify the active branches, but their own order does not affect which
  // branch wins. `default` is always eligible as the universal fallback.
  for (const [condition, value] of Object.entries(record)) {
    if (condition !== 'default' && !conditions.has(condition)) continue;
    const target = resolveExportsEntryWithConditions(value, conditions);
    if (target) return target;
  }

  return undefined;
}

function substituteExportsWildcard(target: unknown, patternMatch: string): unknown {
  if (typeof target === 'string') return target.split('*').join(patternMatch);
  if (Array.isArray(target)) {
    return target.map((entry) => substituteExportsWildcard(entry, patternMatch));
  }
  if (target && typeof target === 'object') {
    const source = target as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source))
      out[key] = substituteExportsWildcard(source[key], patternMatch);
    return out;
  }
  return target;
}

function matchExportsSubpath(record: Record<string, unknown>, subpath: string): unknown {
  if (subpath in record) return record[subpath];

  let bestKey: string | undefined;
  let bestBaseLength = -1;
  let bestKeyLength = -1;
  for (const key of Object.keys(record)) {
    const wildcardIndex = key.indexOf('*');
    if (wildcardIndex === -1) continue;
    const patternBase = key.slice(0, wildcardIndex);
    const patternTrailer = key.slice(wildcardIndex + 1);
    if (patternTrailer.includes('*')) continue;
    if (!subpath.startsWith(patternBase) || !subpath.endsWith(patternTrailer)) continue;
    if (subpath.length <= patternBase.length + patternTrailer.length) continue;
    if (
      patternBase.length > bestBaseLength ||
      (patternBase.length === bestBaseLength && key.length > bestKeyLength)
    ) {
      bestKey = key;
      bestBaseLength = patternBase.length;
      bestKeyLength = key.length;
    }
  }
  if (bestKey === undefined) return undefined;

  const patternTrailer = bestKey.slice(bestKey.indexOf('*') + 1);
  const patternMatch = subpath.slice(bestBaseLength, subpath.length - patternTrailer.length);
  return substituteExportsWildcard(record[bestKey], patternMatch);
}

function getPackageExportsTarget(pkg: string, packageName: string, exportsField: unknown): unknown {
  if (typeof exportsField === 'string') return pkg === packageName ? exportsField : undefined;
  if (!exportsField || typeof exportsField !== 'object') return undefined;

  const record = exportsField as Record<string, unknown>;
  const subpath = pkg === packageName ? '.' : `.${pkg.slice(packageName.length)}`;
  if (subpath !== '.') return matchExportsSubpath(record, subpath);

  return (
    record['.'] ?? (!Object.keys(record).some((key) => key.startsWith('.')) ? record : undefined)
  );
}

/** Whether `pkg` can be located from `opts.cwd` (or the detection cwd). Aliased or non-hoisted packages may still resolve through Vite. */
export function isPackageInstalled(pkg: string, opts: PackageEntryConditions = {}): boolean {
  return getInstalledPackageJson(getPackageName(pkg), opts) !== undefined;
}

/**
 * Whether the installed package's `exports` field permits `pkg`. Lenient when the package cannot
 * be found or has no `exports`: callers that need a hard "is installed" gate use `isPackageInstalled`.
 */
export function isPackageExportAvailable(pkg: string, opts: PackageEntryConditions = {}): boolean {
  const packageName = getPackageName(pkg);
  const installed = getInstalledPackageJson(packageName, opts);
  if (installed?.packageJson.exports == null) return true;
  return (
    resolveExportsEntry(
      getPackageExportsTarget(pkg, packageName, installed.packageJson.exports),
      opts.conditions
    ) !== undefined
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

// Shared-module specifiers aren't always bare package names — they can
// include a deep import subpath (e.g. "@scope/pkg/components/some/nested/
// export", the shared-config key for a specific component export). Once
// substituted, such a specifier can produce an id longer than `NAME_MAX`
// (255 bytes on macOS/Linux), which fails when that id is used as a single
// filesystem path segment (e.g. resolved as a bare specifier under
// node_modules/<id>/package.json during dep optimization, or as a built
// chunk/asset file name). Once the substituted id is longer than this
// threshold, fall back to a short, filesystem-safe id made of a readable
// prefix (for debuggability) plus a content hash (for uniqueness), with no
// separator between them so the budget goes entirely to the readable prefix
// rather than to delimiters. The mapping is kept so the original name can be
// recovered wherever the id needs to be decoded again.
//
// 90 (rather than hugging 255) leaves a safety margin for
// VirtualModule#getImportId(), the tightest consumer: its id is
// `virtual:mf:` + mfNamePart + tag + namePart + tag + suffix, where both
// mfNamePart and namePart are independently run through this same function
// and so are each capped at this threshold. Worst case (both maxed out, the
// longest tag `__treeShakingProvider__` = 23 chars, a `.mjs` suffix):
// 11 + 90 + 90 + 2 * 23 + 4 = 241, which stays under 255 with margin. 100 would
// already overflow that case (263).
const MF_HASHED_NAME_THRESHOLD = 90;
const MF_HASHED_NAME_HASH_LENGTH = 16;
const MF_HASHED_NAME_PREFIX_LENGTH = MF_HASHED_NAME_THRESHOLD - MF_HASHED_NAME_HASH_LENGTH;
// Process-local: a hashed id can only be decoded by the process that encoded
// it. That is sufficient because the hash is deterministic and every hashed id
// is (re)created via packageNameEncode before any decode of it can happen.
const mfHashedNameMap = new Map<string, string>();

/**
 * Encodes a package name (or shared-module specifier, which may include a
 * deep import subpath) into a valid file name, falling back to a
 * readable-prefix + content-hash id when the plain encoding would be too
 * long for a filesystem path segment.
 * @param {string} name - The package name or specifier, e.g., "@scope/xx-xx.xx" or "@scope/pkg/deep/sub-path".
 * @returns {string} - The encoded file name.
 */
export function packageNameEncode(name: string) {
  if (typeof name !== 'string') {
    throw createModuleFederationError('A string package name is required');
  }
  const encoded = name
    .replace(/@/g, '_mf_0_')
    .replace(/\//g, '_mf_1_')
    .replace(/-/g, '_mf_2_')
    .replace(/\./g, '_mf_3_');
  if (encoded.length <= MF_HASHED_NAME_THRESHOLD) return encoded;

  const prefix = encoded.slice(0, MF_HASHED_NAME_PREFIX_LENGTH);
  const hash = createHash('sha256').update(name).digest('hex').slice(0, MF_HASHED_NAME_HASH_LENGTH);
  const hashedName = `${prefix}${hash}`;
  mfHashedNameMap.set(hashedName, name);
  return hashedName;
}

/**
 * Decodes an encoded file name back to the original package name or
 * shared-module specifier, whether it was plainly substituted or hashed
 * down by `packageNameEncode`.
 * @param {string} encoded - The encoded file name, e.g., "_mf_0_scope_mf_1_xx_mf_2_xx_mf_3_xx".
 * @returns {string} - The decoded package name or specifier.
 */
export function packageNameDecode(encoded: string) {
  if (typeof encoded !== 'string') {
    throw createModuleFederationError('A string encoded file name is required');
  }
  const original = mfHashedNameMap.get(encoded);
  if (original !== undefined) return original;
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

export function getPackageNameFromNodeModulePath(source: string): string | undefined {
  const suffix = getNodeModulesSuffix(source);
  if (!suffix) return;

  const parts = suffix.split('/');
  if (!parts[0]) return;
  if (parts[0].startsWith('@')) return parts[1] ? `${parts[0]}/${parts[1]}` : undefined;
  return parts[0];
}

type SharedCacheDescriptor = {
  canonical: string;
  aliases?: string[];
};

type SharedCacheKeyInput = {
  pkg: string;
  singleton?: boolean;
  version?: string;
  scope?: string | string[];
};

export function getSharedCacheKeyParts(input: SharedCacheKeyInput) {
  const normalizedScope = Array.isArray(input.scope) ? input.scope[0] : input.scope;
  const scope = normalizedScope || 'default';
  const id = input.singleton || !input.version ? input.pkg : `${input.pkg}@${input.version}`;
  return {
    scope,
    id,
    key: `${scope}:${id}`,
  };
}

export function getSharedCacheDescriptor(pkg: string, shareItem: ShareItem): SharedCacheDescriptor {
  const parts = getSharedCacheKeyParts({
    pkg,
    singleton: shareItem.shareConfig.singleton,
    version: shareItem.version,
    scope: shareItem.scope,
  });
  return {
    canonical: parts.key,
    ...(parts.scope === 'default' ? { aliases: [parts.id] } : {}),
  };
}

export function getSharedCacheKey(pkg: string, shareItem: ShareItem) {
  return getSharedCacheDescriptor(pkg, shareItem).canonical;
}

export const sharedCacheHelperCode = `const __mfGetSharedCacheDescriptor = (pkg, singleton, version, scope) => {
            const normalizedScope = Array.isArray(scope) ? scope[0] : scope;
            const scopeName = normalizedScope || "default";
            const id = singleton || !version ? pkg : pkg + "@" + version;
            const descriptor = { canonical: scopeName + ":" + id };
            if (scopeName === "default") descriptor.aliases = [id];
            return descriptor;
          };
          const __mfReadSharedCache = (cache, descriptor) => {
            const value = cache[descriptor.canonical];
            if (value !== undefined) return value;
            const aliases = descriptor.aliases || [];
            for (const alias of aliases) {
              if (!Object.prototype.hasOwnProperty.call(cache, alias)) continue;
              const aliasValue = cache[alias];
              if (aliasValue !== undefined) {
                cache[descriptor.canonical] = aliasValue;
                return aliasValue;
              }
            }
            return undefined;
          };
          const __mfSharedCacheListenersKey = Symbol.for("module-federation.shared-cache-listeners");
          const __mfGetSharedCacheListeners = (cache) => {
            let listeners = cache[__mfSharedCacheListenersKey];
            if (listeners === undefined) {
              listeners = Object.create(null);
              Object.defineProperty(cache, __mfSharedCacheListenersKey, {
                value: listeners,
                enumerable: false,
                configurable: false,
                writable: false
              });
            }
            return listeners;
          };
          const __mfSubscribeSharedCache = (cache, descriptor, listener) => {
            const listeners = __mfGetSharedCacheListeners(cache);
            (listeners[descriptor.canonical] ||= new Set()).add(listener);
          };
          const __mfSharedCacheOwnersKey = Symbol.for("module-federation.shared-cache-owners");
          const __mfGetSharedCacheOwners = (cache) => {
            let owners = cache[__mfSharedCacheOwnersKey];
            if (owners === undefined) {
              owners = Object.create(null);
              Object.defineProperty(cache, __mfSharedCacheOwnersKey, {
                value: owners,
                enumerable: false,
                configurable: false,
                writable: false
              });
            }
            return owners;
          };
          const __mfReadSharedCacheOwner = (cache, descriptor) =>
            cache[__mfSharedCacheOwnersKey]?.[descriptor.canonical];
          const __mfGetSharedModuleIdentity = (value) => {
            const candidates = [value, value?.default];
            for (const candidate of candidates) {
              if (!candidate || typeof candidate !== "object") continue;
              for (const key of [
                "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE",
                "__TEST_INTERNALS",
                "__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED"
              ]) {
                const internals = candidate[key];
                if (internals && typeof internals === "object") {
                  return { internals, dispatcher: internals.dispatcher };
                }
              }
              if (typeof candidate.useState === "function") return { hook: candidate.useState };
            }
            return undefined;
          };
          const __mfIsSameSharedModule = (current, next) => {
            if (current === next) return true;
            const currentIdentity = __mfGetSharedModuleIdentity(current);
            const nextIdentity = __mfGetSharedModuleIdentity(next);
            if (!currentIdentity || !nextIdentity) return false;
            return currentIdentity.internals === nextIdentity.internals ||
              (currentIdentity.dispatcher !== undefined &&
                currentIdentity.dispatcher !== null &&
                currentIdentity.dispatcher === nextIdentity.dispatcher) ||
              currentIdentity.hook === nextIdentity.hook;
          };
          const __mfWriteSharedCache = (cache, descriptor, value, owner) => {
            const current = __mfReadSharedCache(cache, descriptor);
            if (current !== undefined && __mfIsSameSharedModule(current, value)) return value;
            cache[descriptor.canonical] = value;
            const aliases = descriptor.aliases || [];
            for (const alias of aliases) {
              Object.defineProperty(cache, alias, {
                value,
                enumerable: true,
                configurable: true,
                writable: true
              });
            }
            const owners = cache[__mfSharedCacheOwnersKey];
            if (owner === undefined) {
              if (owners) delete owners[descriptor.canonical];
            } else {
              __mfGetSharedCacheOwners(cache)[descriptor.canonical] = owner;
            }
            const listeners = cache[__mfSharedCacheListenersKey]?.[descriptor.canonical];
            if (listeners) {
              for (const listener of listeners) listener(value);
            }
            return value;
          };
          const __mfTreeShakingSharedCacheKey = Symbol.for("module-federation.tree-shaking-shared-cache");
          const __mfGetTreeShakingSharedCache = (cache) => {
            let metadata = cache[__mfTreeShakingSharedCacheKey];
            if (metadata === undefined) {
              metadata = Object.create(null);
              Object.defineProperty(cache, __mfTreeShakingSharedCacheKey, {
                value: metadata,
                enumerable: false,
                configurable: false,
                writable: false
              });
            }
            return metadata;
          };
          const __mfReadTreeShakingSharedCache = (cache, descriptor, requiredExports) => {
            const fullModule = __mfReadSharedCache(cache, descriptor);
            if (fullModule !== undefined) return fullModule;
            if (!Array.isArray(requiredExports)) return undefined;
            const metadata = cache[__mfTreeShakingSharedCacheKey];
            const entries = metadata?.[descriptor.canonical] || [];
            let compatibleEntry;
            for (const entry of entries) {
              if (!requiredExports.every((name) => entry.providedExports.includes(name))) continue;
              if (!compatibleEntry || entry.providedExports.length < compatibleEntry.providedExports.length) {
                compatibleEntry = entry;
              }
            }
            return compatibleEntry?.value;
          };
          const __mfWriteTreeShakingSharedCache = (cache, descriptor, providedExports, value) => {
            if (!Array.isArray(providedExports)) return value;
            const normalizedExports = [...new Set(providedExports)].sort();
            const metadata = __mfGetTreeShakingSharedCache(cache);
            const entries = (metadata[descriptor.canonical] ||= []);
            const existing = entries.find((entry) =>
              entry.providedExports.length === normalizedExports.length &&
              entry.providedExports.every((name, index) => name === normalizedExports[index])
            );
            if (existing) existing.value = value;
            else entries.push({ providedExports: normalizedExports, value });
            return value;
          };
          const __mfTreeShakingSelectionCacheKey = Symbol.for("module-federation.tree-shaking-shared-selection-cache");
          const __mfGetTreeShakingSelectionCache = (cache) => {
            let selections = cache[__mfTreeShakingSelectionCacheKey];
            if (selections === undefined) {
              selections = Object.create(null);
              Object.defineProperty(cache, __mfTreeShakingSelectionCacheKey, {
                value: selections,
                enumerable: false,
                configurable: false,
                writable: false
              });
            }
            return selections;
          };
          const __mfReadTreeShakingSharedSelection = (cache, descriptor, consumer) => {
            const fullModule = __mfReadSharedCache(cache, descriptor);
            if (fullModule !== undefined) return fullModule;
            return cache[__mfTreeShakingSelectionCacheKey]?.[descriptor.canonical]?.[consumer];
          };
          const __mfWriteTreeShakingSharedSelection = (cache, descriptor, consumer, value) => {
            const selections = __mfGetTreeShakingSelectionCache(cache);
            const byConsumer = (selections[descriptor.canonical] ||= Object.create(null));
            byConsumer[consumer] = value;
            return value;
          };`;

export function getInstalledPackageJson(
  pkg: string,
  opts?: PackageEntryConditions
): InstalledPackageJson | undefined {
  const cwd = opts?.cwd || getPackageDetectionCwd();
  const packageName = opts?.packageName || getPackageName(pkg);
  const cacheKey = `${cwd}\0${pkg}\0${packageName}\0${opts?.fromResolvedEntry ?? ''}`;
  if (installedPackageJsonCache.has(cacheKey)) {
    return installedPackageJsonCache.get(cacheKey);
  }
  const result = resolveInstalledPackageJson(pkg, cwd, packageName, opts);
  installedPackageJsonCache.set(cacheKey, result);
  return result;
}

function tryReadPackageJson(
  packageJsonPath: string,
  expectedName?: string
): InstalledPackageJson | undefined {
  if (!existsSync(packageJsonPath)) return undefined;
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    if (expectedName !== undefined && packageJson.name !== expectedName) return undefined;
    return { path: packageJsonPath, dir: path.dirname(packageJsonPath), packageJson };
  } catch {
    return undefined;
  }
}

function resolveInstalledPackageJson(
  pkg: string,
  cwd: string,
  packageName: string,
  opts?: PackageEntryConditions
): InstalledPackageJson | undefined {
  const findPackageInPnpmStore = (startDir: string): InstalledPackageJson | undefined => {
    let currentDir = startDir;

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
      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) break;
      currentDir = parentDir;
    }
  };

  let resolvedPath: string | undefined;
  try {
    const projectRequire = createRequire(pathToFileURL(path.join(cwd, 'package.json')));
    if (opts?.fromResolvedEntry) {
      resolvedPath = opts.fromResolvedEntry;
    } else {
      try {
        resolvedPath = projectRequire.resolve(pkg);
      } catch {
        resolvedPath = projectRequire.resolve(packageName);
      }
    }
  } catch {
    resolvedPath = undefined;
  }
  // A Node core module resolves to its bare specifier (`readline`, `node:readline`), not to a file:
  // there is no directory to walk up from, so look for an installed package of that name instead.
  if (resolvedPath !== undefined && !path.isAbsolute(resolvedPath)) {
    resolvedPath = undefined;
  }

  if (resolvedPath !== undefined) {
    const owner = findOwningPackageJson(path.dirname(resolvedPath), packageName);
    if (owner) return owner;
  }

  let currentDir = cwd;
  while (true) {
    const packageJsonPath = path.join(currentDir, 'node_modules', packageName, 'package.json');
    const directCandidate = tryReadPackageJson(packageJsonPath);
    if (directCandidate?.packageJson.name === packageName) return directCandidate;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  return findPackageInDependents(packageName, cwd) ?? findPackageInPnpmStore(cwd);
}

/**
 * A package installed only under a dependent is invisible to the walks above.
 * Resolving it from each dependent in turn follows the same links that dependent
 * does, so the copy found is the version it is installed against rather than
 * whichever one the pnpm store happens to list first.
 */
function findPackageInDependents(
  packageName: string,
  cwd: string
): InstalledPackageJson | undefined {
  const rootPackageJson = path.join(cwd, 'package.json');
  const root = tryReadPackageJson(rootPackageJson);
  if (!root) return undefined;

  // Keyed by the resolved package.json, not the name: two branches can carry
  // two versions of the same package, and only one of them may declare the target.
  const visited = new Set<string>();
  // The app's devDependencies are installed as well, and a Vite app commonly keeps
  // its libraries there. Deeper packages have only their runtime dependencies.
  const queue = getDependencyNames(root.packageJson, { includeDev: true }).map((name) => ({
    name,
    from: rootPackageJson,
  }));

  while (queue.length) {
    const { name, from } = queue.shift()!;
    if (name === packageName) continue;
    const dependent = resolvePackageFrom(name, from);
    if (!dependent || visited.has(dependent.path)) continue;
    visited.add(dependent.path);
    const dependencies = getDependencyNames(dependent.packageJson);
    // Only a declared edge is followed. Node resolution from a package that
    // merely sits near the target walks up into a hoisted copy, which is the
    // arbitrary pick this walk exists to avoid.
    if (dependencies.includes(packageName)) {
      const candidate = resolvePackageFrom(packageName, dependent.path);
      if (candidate) return candidate;
    }
    for (const dependency of dependencies) {
      queue.push({ name: dependency, from: dependent.path });
    }
  }

  return undefined;
}

/** Node resolution from `from`, then the walk up to the package.json that owns the result. */
function resolvePackageFrom(packageName: string, from: string): InstalledPackageJson | undefined {
  let resolved: string;
  try {
    resolved = createRequire(pathToFileURL(from)).resolve(packageName);
  } catch {
    return undefined;
  }
  // A core module resolves to its bare specifier: there is nothing to walk up from.
  if (!path.isAbsolute(resolved)) return undefined;
  return findOwningPackageJson(path.dirname(resolved), packageName);
}

/**
 * Walks up from `startDir` to the package.json named `packageName`, preferring the
 * one at `node_modules/<packageName>` so a nested `package.json` (for example a
 * subpath's `type: module` marker) does not shadow the package root.
 */
function findOwningPackageJson(
  startDir: string,
  packageName: string
): InstalledPackageJson | undefined {
  let currentDir = startDir;
  let matchingPackage: InstalledPackageJson | undefined;
  while (true) {
    const candidate = tryReadPackageJson(path.join(currentDir, 'package.json'), packageName);
    if (candidate) {
      if (currentDir.endsWith(path.join('node_modules', packageName))) return candidate;
      matchingPackage ??= candidate;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return matchingPackage;
    currentDir = parentDir;
  }
}

export function getDependencyNames(
  packageJson: Record<string, unknown> | undefined,
  { includeDev = false }: { includeDev?: boolean } = {}
): string[] {
  if (!packageJson) return [];
  const names = new Set<string>();
  const fields = ['dependencies', 'peerDependencies', 'optionalDependencies'];
  if (includeDev) fields.push('devDependencies');
  for (const field of fields) {
    const deps = packageJson[field];
    if (!deps || typeof deps !== 'object') continue;
    for (const dep of Object.keys(deps)) names.add(dep);
  }
  return [...names];
}

export function getInstalledPackageEntry(
  pkg: string,
  opts?: PackageEntryConditions
): string | undefined {
  const installed = getInstalledPackageJson(pkg, opts);
  if (!installed) return undefined;
  const cwd = opts?.cwd || getPackageDetectionCwd();
  const packageName = opts?.packageName || getPackageName(pkg);
  const packageJson = installed.packageJson;
  if (
    pkg !== packageName &&
    (opts?.resolveSubpathWithRequire !== false || packageJson.exports === undefined)
  ) {
    try {
      const projectRequire = createRequire(pathToFileURL(path.join(cwd, 'package.json')));
      return projectRequire.resolve(pkg);
    } catch {
      // Fall back to root package entry resolution below.
    }
  }
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

/** Walk up from Vite `config.root` (Nuxt may point at `.nuxt` cache dirs). */
export function isNuxtProjectRoot(root: string): boolean {
  let dir = root;
  for (let i = 0; i < 8; i++) {
    if (hasPackageDependency('nuxt', dir) || hasPackageDependency('nuxt-nightly', dir)) {
      return true;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
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

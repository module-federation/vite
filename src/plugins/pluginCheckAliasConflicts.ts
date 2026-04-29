import type { Alias, Plugin } from 'vite';
import { NormalizedShared } from '../utils/normalizeModuleFederationOptions';
import { mfWarn } from '../utils/logger';
import { getPackageNameFromNodeModulePath } from '../utils/packageUtils';

/**
 * Check if user-defined alias conflicts with shared modules
 * This should run after aliasToArrayPlugin to ensure alias is an array
 */
export function checkAliasConflicts(options: { shared?: NormalizedShared }): Plugin {
  const { shared = {} } = options;
  const sharedKeys = Object.keys(shared);

  return {
    name: 'check-alias-conflicts',
    configResolved(config: any) {
      if (sharedKeys.length === 0) return;

      const userAliases: Alias[] = config.resolve?.alias || [];
      const conflicts: Array<{ sharedModule: string; alias: string; target: string }> = [];

      const matchesSharedKey = (aliasEntry: Alias, sharedKey: string) => {
        const findPattern = aliasEntry.find;

        if (typeof findPattern === 'string') {
          return findPattern === sharedKey || sharedKey.startsWith(findPattern + '/');
        }
        if (findPattern instanceof RegExp) {
          return findPattern.test(sharedKey);
        }

        return false;
      };

      for (const sharedKey of sharedKeys) {
        for (const aliasEntry of userAliases) {
          const replacement = aliasEntry.replacement;
          if (!matchesSharedKey(aliasEntry, sharedKey)) continue;

          // Module Federation aliases are prepended. Once one matches, later
          // user aliases for the same package no longer bypass sharing.
          if (replacement === '$1') break;

          if (typeof replacement === 'string') {
            const packageName = getPackageNameFromNodeModulePath(replacement);
            const sharedPackageName = sharedKey.endsWith('/') ? sharedKey.slice(0, -1) : sharedKey;
            if (packageName === sharedPackageName) continue;

            conflicts.push({
              sharedModule: sharedKey,
              alias: String(aliasEntry.find),
              target: replacement,
            });
          }
        }
      }

      if (conflicts.length > 0) {
        mfWarn('Detected alias conflicts with shared modules:');
        conflicts.forEach(({ sharedModule, alias, target }) => {
          mfWarn(`Shared module "${sharedModule}" is aliased by "${alias}" to "${target}"`);
        });
        mfWarn(
          "This may cause runtime errors as the shared module will bypass Module Federation's sharing mechanism."
        );
      }
    },
  };
}

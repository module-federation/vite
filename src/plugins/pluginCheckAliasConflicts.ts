import type { Alias, Plugin } from 'vite';
import { NormalizedShared } from '../utils/normalizeModuleFederationOptions';

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

      for (const sharedKey of sharedKeys) {
        for (const aliasEntry of userAliases) {
          const findPattern = aliasEntry.find;
          const replacement = aliasEntry.replacement;

          // Skip if replacement is not a string (e.g., customResolver)
          if (typeof replacement !== 'string') continue;

          // Check if alias pattern matches the shared module
          let isMatch = false;
          if (typeof findPattern === 'string') {
            isMatch = findPattern === sharedKey || sharedKey.startsWith(findPattern + '/');
          } else if (findPattern instanceof RegExp) {
            isMatch = findPattern.test(sharedKey);
          }

          if (isMatch) {
            conflicts.push({
              sharedModule: sharedKey,
              alias: String(findPattern),
              target: replacement,
            });
          }
        }
      }

      if (conflicts.length > 0) {
        config.logger.warn('\n[Module Federation] Detected alias conflicts with shared modules:');
        conflicts.forEach(({ sharedModule, alias, target }) => {
          config.logger.warn(
            `  - Shared module "${sharedModule}" is aliased by "${alias}" to "${target}"`
          );
        });
        config.logger.warn(
          "  This may cause runtime errors as the shared module will bypass Module Federation's sharing mechanism."
        );
      }
    },
  };
}

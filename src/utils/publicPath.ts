import { NormalizedModuleFederationOptions } from './normalizeModuleFederationOptions';

/**
 * Resolves the public path for remote entries
 * @param options - Module Federation options
 * @param viteBase - Vite's base config value
 * @param originalBase - Original base config before any transformations
 * @returns The resolved public path
 */
export function resolvePublicPath(
  options: NormalizedModuleFederationOptions,
  viteBase: string,
  originalBase?: string
): string {
  // Use explicitly set publicPath if provided
  if (options.publicPath) {
    return options.publicPath;
  }

  // Handle empty original base case
  if (originalBase === '') {
    return 'auto';
  }

  // Use viteBase if available, ensuring it ends with a slash
  if (viteBase) {
    return viteBase.replace(/\/?$/, '/');
  }

  // Fallback to auto if no base is specified
  return 'auto';
}

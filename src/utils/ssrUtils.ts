import { hasPackageDependency } from './packageUtils';

/**
 * Resolver context with Vite 6+ environment API support.
 * @see https://vite.dev/guide/api-environment-plugins
 */
export interface ResolverContext {
  environment?: {
    name: string;
  };
  resolve: (source: string, importer?: string) => Promise<{ id: string } | null>;
}

/**
 * Check if current environment is SSR.
 * Uses Vite 6+ environment API to detect SSR context.
 */
export function isSSREnvironment(context: Partial<ResolverContext>): boolean {
  return context.environment?.name === 'ssr';
}

/**
 * SSR framework entry point mappings.
 * Maps package name to array of entry file patterns to inject MF runtime into.
 *
 * These are virtual entry points used by SSR frameworks that don't have
 * an index.html file. The MF runtime needs to be injected into these
 * entry points to initialize federation before the application loads.
 */
export const SSR_FRAMEWORK_ENTRIES: Record<string, string[]> = {
  vinext: ['virtual:vite-rsc/entry-browser', 'virtual:vinext-app-browser-entry'],
  '@tanstack/react-start': ['virtual:tanstack-start-client-entry', 'default-entry/client'],
};

/**
 * Check if a module ID matches any SSR framework entry point.
 * Returns the matching framework package name, or null if no match.
 *
 * This enables unified entry injection across all supported SSR frameworks
 * instead of framework-specific conditionals.
 */
export function matchSSRFrameworkEntry(id: string): string | null {
  for (const [pkg, entries] of Object.entries(SSR_FRAMEWORK_ENTRIES)) {
    if (hasPackageDependency(pkg) && entries.some((entry) => id.includes(entry))) {
      return pkg;
    }
  }
  return null;
}

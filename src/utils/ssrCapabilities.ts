export type MfCommand = 'serve' | 'build';

/** A browser-safe generated expression that is true only in Node.js. */
// Use Vite's environment flag rather than process.versions.node. Frameworks
// such as Nuxt can expose a browser process shim containing versions.node,
// which made client remote wrappers enter the SSR bootstrap and silently
// resolve through its fallback instead of fetching the browser remote entry.
export const SERVER_ENV_GUARD = 'import.meta.env.SSR';

export interface SsrCapabilities {
  /** Emit server-side MF runtime bootstrap (ssrEntryLoader import) in dev remote wrappers. */
  enableSsrInitBootstrap: boolean;
  /** Auto-inject `@module-federation/vite/ssrEntryLoader` into `runtimePlugins`. */
  injectSsrEntryLoader: boolean;
}

/**
 * Single source of truth for SSR-related feature gates.
 *
 * - Vite 8+ dev: ModuleRunner + FetchableDevEnvironment for `/__mf_ssr__/` entries.
 * - Any Vite major on build/preview: HTTP fetch + temp-file import via ssrEntryLoader.
 */
export function getSsrCapabilities(
  viteMajor: number,
  command: MfCommand,
  hasRemotes: boolean
): SsrCapabilities {
  if (!hasRemotes) {
    return { enableSsrInitBootstrap: false, injectSsrEntryLoader: false };
  }

  const devModuleRunner = viteMajor >= 8;
  const supported = command === 'build' || (command === 'serve' && devModuleRunner);

  return {
    enableSsrInitBootstrap: supported,
    injectSsrEntryLoader: supported,
  };
}

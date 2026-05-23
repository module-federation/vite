export type MfCommand = 'serve' | 'build';

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

export type MfCommand = 'serve' | 'build';

/** A browser-safe generated expression that is true only in Node.js. */
// Use Vite's environment flag rather than process.versions.node. Frameworks
// such as Nuxt can expose a browser process shim containing versions.node,
// which made client remote wrappers enter the SSR bootstrap and silently
// resolve through its fallback instead of fetching the browser remote entry.
export const SERVER_ENV_GUARD = 'import.meta.env.SSR';

export const SSR_ENTRY_LOADER_SPECIFIER = '@module-federation/vite/ssrEntryLoader' as const;
export const SSR_ONLY_RUNTIME_PLUGINS = new Set<string>([SSR_ENTRY_LOADER_SPECIFIER]);

export interface SsrCapabilities {
  /** Emit server-side MF runtime bootstrap (ssrEntryLoader import) in dev remote wrappers. */
  enableSsrInitBootstrap: boolean;
  /** Auto-inject `@module-federation/vite/ssrEntryLoader` into `runtimePlugins`. */
  injectSsrEntryLoader: boolean;
}

type SsrEnvironmentConfig = {
  consumer?: string;
  config?: {
    consumer?: string;
    build?: { ssr?: boolean | string };
  };
  build?: { ssr?: boolean | string };
};

export type SsrConfig = SsrEnvironmentConfig & {
  environments?: Record<string, SsrEnvironmentConfig>;
};

/**
 * Detect whether Vite is resolving a server graph.
 *
 * Vite 6+ exposes the environment consumer on `environment.config`, while
 * older Vite versions use `build.ssr`. Resolved Vite 8 environment configs
 * expose the same consumer directly, so support that shape too.
 */
export function isSsrConfig(config: SsrConfig): boolean {
  if (
    config.consumer === 'server' ||
    config.config?.consumer === 'server' ||
    Boolean(config.build?.ssr) ||
    Boolean(config.config?.build?.ssr)
  ) {
    return true;
  }

  return Object.values(config.environments ?? {}).some(
    (environment) =>
      environment.consumer === 'server' ||
      environment.config?.consumer === 'server' ||
      Boolean(environment.build?.ssr) ||
      Boolean(environment.config?.build?.ssr)
  );
}

/**
 * Single source of truth for SSR-related feature gates.
 *
 * - Vite 8+ server environments: ModuleRunner + FetchableDevEnvironment for
 *   `/__mf_ssr__/` entries.
 * - SSR builds on any Vite major: HTTP fetch + temp-file import via
 *   ssrEntryLoader.
 */
export function getSsrCapabilities(
  viteMajor: number,
  command: MfCommand,
  hasRemotes: boolean,
  isSsr = false
): SsrCapabilities {
  if (!hasRemotes) {
    return { enableSsrInitBootstrap: false, injectSsrEntryLoader: false };
  }

  const devModuleRunner = viteMajor >= 8;
  const supported = isSsr && (command === 'build' || (command === 'serve' && devModuleRunner));

  return {
    enableSsrInitBootstrap: supported,
    injectSsrEntryLoader: supported,
  };
}

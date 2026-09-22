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

/** The environment fields that mark a server graph, on Vite 5–8 shapes. */
export type SsrEnvironmentConfig = {
  consumer?: string;
  build?: { ssr?: boolean | string };
};

export type SsrConfig = SsrEnvironmentConfig & {
  environments?: Record<string, SsrEnvironmentConfig>;
};

/**
 * Whether a Vite environment builds a server graph.
 *
 * Vite 6+ sets `consumer` on the environment config; `build.ssr` covers the
 * legacy `vite build --ssr` flag. Environment names are user-defined, so `ssr`
 * and `server` are only a fallback for configs that carry neither field.
 */
export function isServerEnvironment(
  name: string | undefined,
  config: SsrEnvironmentConfig | undefined
): boolean {
  return (
    config?.consumer === 'server' ||
    Boolean(config?.build?.ssr) ||
    name === 'ssr' ||
    name === 'server'
  );
}

/**
 * Whether a resolved Vite config includes a server graph: the legacy
 * `build.ssr` flag, or any server environment. Vite always registers an `ssr`
 * environment for `serve`, so this only gates builds.
 */
export function isSsrConfig(config: SsrConfig): boolean {
  if (Boolean(config.build?.ssr)) return true;
  return Object.entries(config.environments ?? {}).some(([name, environment]) =>
    isServerEnvironment(name, environment)
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

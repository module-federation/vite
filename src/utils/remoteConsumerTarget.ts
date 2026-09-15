/** Where a remote virtual wrapper is consumed (Vite environment or legacy unified). */
export type RemoteConsumerTarget = 'client' | 'server';

/**
 * `unified` keeps a single wrapper with runtime `typeof window` checks (Vite 5–7
 * and other single-environment graphs). Split `client` / `server` when the
 * Environment API is active.
 */
export type RemoteConsumer = RemoteConsumerTarget | 'unified';

export function getPluginEnvironmentName(ctx: unknown): string | undefined {
  if (ctx == null || typeof ctx !== 'object') return undefined;
  const environment = (ctx as Record<string, unknown>)['environment'];
  if (environment == null || typeof environment !== 'object') return undefined;
  const name = (environment as Record<string, unknown>)['name'];
  return typeof name === 'string' ? name : undefined;
}

/**
 * Classify a plugin hook context's Vite environment. Environment names are
 * user-defined, so Vite's `config.consumer` is the semantic role; fall back to
 * the name only when it is missing (Vite 5–7). Returns `undefined` when the hook
 * has no environment context at all.
 */
export function resolveEnvironmentConsumerTarget(ctx: unknown): RemoteConsumerTarget | undefined {
  if (ctx == null || typeof ctx !== 'object') return undefined;
  const environment = (ctx as Record<string, unknown>)['environment'];
  if (environment == null || typeof environment !== 'object') return undefined;
  const consumer = (environment as { config?: { consumer?: unknown } }).config?.consumer;
  if (consumer === 'client' || consumer === 'server') return consumer;
  const envName = getPluginEnvironmentName(ctx);
  return !envName || envName === 'client' ? 'client' : 'server';
}

/** Vite 5–7 hooks have no environment context and keep their client build behavior. */
export function isClientEnvironment(ctx: unknown): boolean {
  return resolveEnvironmentConsumerTarget(ctx) !== 'server';
}

export function resolveRemoteConsumer(ctx: unknown, hasMultiEnvironment: boolean): RemoteConsumer {
  if (!hasMultiEnvironment) return 'unified';
  return resolveEnvironmentConsumerTarget(ctx) ?? 'client';
}

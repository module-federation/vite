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

export function resolveRemoteConsumer(ctx: unknown, hasMultiEnvironment: boolean): RemoteConsumer {
  if (!hasMultiEnvironment) return 'unified';
  const envName = getPluginEnvironmentName(ctx);
  if (!envName || envName === 'client') return 'client';
  return 'server';
}

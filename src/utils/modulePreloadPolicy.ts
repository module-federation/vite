/**
 * Vite lets a build decide what its pages preload through
 * `build.modulePreload.resolveDependencies`. The plugin writes two preload
 * lists of its own — the host page's `<link rel="modulepreload">` tags and
 * the warmup a remote entry replays at runtime — so those lists go through
 * the same function, with the same `hostType` Vite would use, and a host
 * that trims Vite's list trims ours too.
 */
export type ResolveDependencies = (
  filename: string,
  deps: string[],
  context: { hostId: string; hostType: 'html' | 'js' }
) => string[];

const USER_RESOLVE_DEPENDENCIES = Symbol.for('module-federation.vite-user-resolve-dependencies');

type FederationResolveDependencies = ResolveDependencies & {
  [USER_RESOLVE_DEPENDENCIES]?: ResolveDependencies | null;
};

let userResolveDependencies: ResolveDependencies | undefined;

/** The function the user configured, seen through the plugin's own wrapper when a second federation config runs after the first. */
export function unwrapUserResolveDependencies(
  resolveDependencies: ResolveDependencies | undefined
): ResolveDependencies | undefined {
  if (!resolveDependencies) return undefined;
  const user = (resolveDependencies as FederationResolveDependencies)[USER_RESOLVE_DEPENDENCIES];
  if (user === undefined) return resolveDependencies;
  return user ?? undefined;
}

/** Tags the plugin's wrapper with the user function it wraps, so `unwrapUserResolveDependencies` can find it again. */
export function markFederationResolveDependencies<T extends ResolveDependencies>(
  wrapper: T,
  user: ResolveDependencies | undefined
): T {
  (wrapper as FederationResolveDependencies)[USER_RESOLVE_DEPENDENCIES] = user ?? null;
  return wrapper;
}

export function rememberUserResolveDependencies(
  resolveDependencies: ResolveDependencies | undefined
) {
  userResolveDependencies = unwrapUserResolveDependencies(resolveDependencies);
}

/** Runs one of the plugin's preload lists through the user's function; without one the list is returned as is. */
export function applyUserResolveDependencies(
  hostId: string,
  files: string[],
  hostType: 'html' | 'js'
): string[] {
  if (!userResolveDependencies) return files;
  return userResolveDependencies(hostId, files, { hostId, hostType });
}

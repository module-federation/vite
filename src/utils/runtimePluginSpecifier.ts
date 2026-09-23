/** A `runtimePlugins` entry: a bare specifier, or `[specifier, options]`. */
export type RuntimePluginEntry = string | [string, Record<string, unknown>];

export function getRuntimePluginSpecifier(plugin: RuntimePluginEntry): string {
  return typeof plugin === 'string' ? plugin : plugin[0];
}

/** Drop SSR-only plugins from a client graph; a server graph keeps them all. */
export function filterRuntimePluginsForTarget<T extends RuntimePluginEntry>(
  runtimePlugins: readonly T[],
  ssrOnlySpecifiers: ReadonlySet<string>,
  isServer: boolean
): T[] {
  if (isServer) return [...runtimePlugins];
  return runtimePlugins.filter(
    (plugin) => !ssrOnlySpecifiers.has(getRuntimePluginSpecifier(plugin))
  );
}

/**
 * MF runtime plugin that publishes `@module-federation/runtime-core` on
 * `globalThis._FEDERATION_RUNTIME_CORE` so remotes with `experiments.externalRuntime`
 * can share the host's runtime-core instead of bundling their own copy.
 *
 * Mirrors `@module-federation/inject-external-runtime-core-plugin` without
 * adding that package (or `runtime-tools`) as a dependency of this plugin.
 */

import * as runtimeCore from '@module-federation/runtime/core';

type BeforeInitArgs = {
  options: { name: string };
};

type FederationGlobal = Record<string, unknown> & {
  _FEDERATION_RUNTIME_CORE?: unknown;
  _FEDERATION_RUNTIME_CORE_FROM?: { name: string; version: string };
};

/** Keep in sync with the `@module-federation/runtime` dependency version. */
const PLUGIN_VERSION = '2.8.0';

export default function injectExternalRuntimeCorePlugin() {
  return {
    name: 'inject-external-runtime-core-plugin',
    version: PLUGIN_VERSION,
    beforeInit(args: BeforeInitArgs) {
      const globalRef = runtimeCore.Global as FederationGlobal | undefined;
      if (!globalRef || typeof globalRef !== 'object') return args;

      const name = args.options.name;
      if (
        globalRef._FEDERATION_RUNTIME_CORE &&
        globalRef._FEDERATION_RUNTIME_CORE_FROM &&
        (globalRef._FEDERATION_RUNTIME_CORE_FROM.name !== name ||
          globalRef._FEDERATION_RUNTIME_CORE_FROM.version !== PLUGIN_VERSION)
      ) {
        console.warn(
          `Detect multiple module federation runtime! Injected runtime from ${globalRef._FEDERATION_RUNTIME_CORE_FROM.name}@${globalRef._FEDERATION_RUNTIME_CORE_FROM.version} and current is ${name}@${PLUGIN_VERSION}, pleasure ensure there is only one consumer to provider runtime!`
        );
        return args;
      }

      globalRef._FEDERATION_RUNTIME_CORE = runtimeCore;
      globalRef._FEDERATION_RUNTIME_CORE_FROM = {
        version: PLUGIN_VERSION,
        name,
      };
      return args;
    },
  };
}

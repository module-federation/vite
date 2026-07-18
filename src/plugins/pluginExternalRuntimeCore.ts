import { pathToFileURL } from 'node:url';
import type { Plugin } from 'vite';
import { createModuleFederationError } from '../utils/logger';
import { resolveImportPath } from '../utils/packageUtils';

export const EXTERNAL_RUNTIME_CORE_VIRTUAL_ID = '\0virtual:mf-external-runtime-core';
/** Package remotes import — rewritten to the host global shim. */
export const RUNTIME_CORE_PACKAGE = '@module-federation/runtime-core';
/**
 * Already depended on via `@module-federation/runtime`. Prefer this for Node
 * introspection so we do not need a direct `runtime-core` dependency.
 */
export const RUNTIME_CORE_INTROSPECT_PACKAGE = '@module-federation/runtime/core';

function isRuntimeCoreId(id: string): boolean {
  return id === RUNTIME_CORE_PACKAGE || id === `${RUNTIME_CORE_PACKAGE}/`;
}

/** True when the importer is part of an SSR remote graph (skip browser shim). */
export function isSsrRemoteRuntimeImporter(importer: string | undefined): boolean {
  if (!importer) return false;
  return (
    importer.includes('virtual:mf-REMOTE_ENTRY_SSR_ID') ||
    importer.includes('virtual:mf-exposes-ssr:') ||
    importer.includes('/__mf_ssr__/')
  );
}

/**
 * Collects runtime-core export names in Node so the virtual shim can emit
 * explicit named re-exports. Rolldown (Vite 8+) does not support
 * syntheticNamedExports the way Rollup does, and `@module-federation/runtime`
 * statically imports many symbols from runtime-core.
 */
export function collectRuntimeCoreExportNames(
  runtimeCoreModule: Record<string, unknown>
): string[] {
  return Object.keys(runtimeCoreModule)
    .filter((key) => key !== 'default' && key !== '__esModule')
    .sort();
}

export function buildExternalRuntimeCoreShimCode(exportNames: string[]): string {
  const namedExports = exportNames
    .map((name) => `export const ${name} = mod[${JSON.stringify(name)}];`)
    .join('\n');

  return `${[
    'const mod = globalThis._FEDERATION_RUNTIME_CORE;',
    'if (!mod) {',
    '  throw new Error("[Module Federation] experiments.externalRuntime is enabled, but globalThis._FEDERATION_RUNTIME_CORE is missing. Enable experiments.provideExternalRuntime on the host consumer.");',
    '}',
    'export default mod.default ?? mod;',
    namedExports,
  ]
    .filter(Boolean)
    .join('\n')}\n`;
}

let cachedExportNames: string[] | undefined;

/** Test-only helper to clear the introspection cache between cases. */
export function resetRuntimeCoreExportNamesCache(): void {
  cachedExportNames = undefined;
}

async function importRuntimeCoreForIntrospection(
  packageName: string
): Promise<Record<string, unknown>> {
  try {
    const resolved = resolveImportPath(packageName);
    return (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
  } catch {
    return (await import(packageName)) as Record<string, unknown>;
  }
}

export async function resolveRuntimeCoreExportNames(): Promise<string[]> {
  if (cachedExportNames) return cachedExportNames;
  try {
    const runtimeCore = await importRuntimeCoreForIntrospection(RUNTIME_CORE_INTROSPECT_PACKAGE);
    cachedExportNames = collectRuntimeCoreExportNames(runtimeCore);
  } catch {
    try {
      // Fallback for older runtime packages without the `/core` export.
      const runtimeCore = await importRuntimeCoreForIntrospection(RUNTIME_CORE_PACKAGE);
      cachedExportNames = collectRuntimeCoreExportNames(runtimeCore);
    } catch {
      cachedExportNames = [];
    }
  }
  return cachedExportNames;
}

/**
 * Replaces `@module-federation/runtime-core` with a virtual module that reads
 * `globalThis._FEDERATION_RUNTIME_CORE` (webpack/Rspack `externalRuntime` parity).
 */
export default function pluginExternalRuntimeCore(): Plugin {
  let shimCodePromise: Promise<string> | undefined;

  const getShimCode = () => {
    if (!shimCodePromise) {
      shimCodePromise = resolveRuntimeCoreExportNames().then((names) => {
        if (names.length === 0) {
          throw createModuleFederationError(
            `Unable to introspect exports from ${RUNTIME_CORE_INTROSPECT_PACKAGE} for experiments.externalRuntime.`
          );
        }
        return buildExternalRuntimeCoreShimCode(names);
      });
    }
    return shimCodePromise;
  };

  return {
    name: 'module-federation-external-runtime-core',
    enforce: 'pre',
    config(config) {
      config.optimizeDeps ??= {};
      config.optimizeDeps.exclude ??= [];
      if (!config.optimizeDeps.exclude.includes(RUNTIME_CORE_PACKAGE)) {
        config.optimizeDeps.exclude.push(RUNTIME_CORE_PACKAGE);
      }
      // Avoid a conflicting prebundle include winning over the virtual shim.
      if (Array.isArray(config.optimizeDeps.include)) {
        config.optimizeDeps.include = config.optimizeDeps.include.filter(
          (dep) =>
            dep !== RUNTIME_CORE_PACKAGE && !String(dep).startsWith(`${RUNTIME_CORE_PACKAGE}/`)
        );
      }
    },
    resolveId(source, importer) {
      if (!isRuntimeCoreId(source)) return;
      if (isSsrRemoteRuntimeImporter(importer)) return;
      return EXTERNAL_RUNTIME_CORE_VIRTUAL_ID;
    },
    async load(id) {
      if (id !== EXTERNAL_RUNTIME_CORE_VIRTUAL_ID) return;
      return getShimCode();
    },
  };
}

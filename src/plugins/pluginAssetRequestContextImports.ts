import type { Plugin } from 'vite';
import { createCodePositionMap } from '../utils/codePositionMap';
import { CodeRewriter } from '../utils/codeRewriter';
import type { OutputChunkWithViteMetadata } from '../utils/cssModuleHelpers';
import type { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { isServerBuildContext } from '../utils/remoteConsumerTarget';
import { normalizeVirtualModuleId } from '../utils/VirtualModule';
import { getVirtualExposesId } from '../virtualModules/virtualExposes';
import { getRemoteEntryId } from '../virtualModules/virtualRemoteEntry';
import { DYNAMIC_IMPORT_REGEX } from './pluginLazyConsumeOnlyShares';

const chunkModuleIds = (chunk: OutputChunkWithViteMetadata) => [
  ...(chunk.facadeModuleId ? [chunk.facadeModuleId] : []),
  ...(chunk.moduleIds ?? Object.keys(chunk.modules ?? {})),
];

/**
 * A container that received `assetRequestContext` in `init()` must fetch the
 * chunks its remote entry and exposes import through
 * `assetRequestContext.request`. Each dynamic `import()` in the chunks holding
 * those two modules is wrapped: when the chunk's url has a context in the blob
 * loader registry (installed by `assetRequestContextProducerPlugin`, see
 * utils/assetRequestContext.ts), the import goes through the registry's
 * `__mfDynImport` shim; otherwise the original `import()` runs.
 * Chunks loaded through the shim are rewritten by the blob loader at runtime,
 * so only these chunks need the build-time wrapper.
 */
export function pluginAssetRequestContextImports(
  options: NormalizedModuleFederationOptions
): Plugin {
  let viteConfig: { build?: { ssr?: boolean | string } } | undefined;
  const helperName = `__mfAssetRequestContextImport_${options.internalName.replace(/[^A-Za-z0-9_$]/g, '_')}`;
  const producerModuleIds = new Set([getRemoteEntryId(options), getVirtualExposesId(options)]);

  return {
    name: 'module-federation:asset-request-context-imports',
    apply: 'build',
    configResolved(config) {
      viteConfig = config as typeof viteConfig;
    },
    renderChunk(code, chunk) {
      const renderedChunk = chunk as unknown as OutputChunkWithViteMetadata;
      if (Object.keys(options.exposes).length === 0) return null;
      if (isServerBuildContext(this, viteConfig)) return null;
      if (
        !chunkModuleIds(renderedChunk).some((id) =>
          producerModuleIds.has(normalizeVirtualModuleId(id))
        )
      ) {
        return null;
      }

      const rewriter = new CodeRewriter(code);
      const codePositions = createCodePositionMap(code);
      let edited = false;
      for (const match of code.matchAll(DYNAMIC_IMPORT_REGEX)) {
        const [expression, , specifier] = match;
        const start = match.index!;
        if (!codePositions[start]) continue;
        rewriter.overwrite(
          start,
          start + expression.length,
          `${helperName}(import.meta.url, ${JSON.stringify(specifier)}, () => ${expression})`
        );
        edited = true;
      }
      if (!edited) return null;
      rewriter.overwrite(
        code.length,
        code.length,
        `
function ${helperName}(base, spec, load) {
  const shim = globalThis.__mfDynImport;
  return typeof shim === "function" && shim.blobLoaderContexts && shim.blobLoaderContexts.has(base) ? shim(base, spec) : load();
}
`
      );
      return { code: rewriter.toString(), map: rewriter.generateMap(renderedChunk.fileName) };
    },
  };
}

export default pluginAssetRequestContextImports;

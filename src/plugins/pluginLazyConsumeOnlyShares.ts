import * as path from 'node:path';
import type { Plugin } from 'vite';
import { createCodePositionMap } from '../utils/codePositionMap';
import { CodeRewriter } from '../utils/codeRewriter';
import {
  collectStaticChunks,
  stripKnownJsExtension,
  type OutputBundleItem,
  type OutputChunkWithViteMetadata,
} from '../utils/cssModuleHelpers';
import {
  getNormalizeShareItem,
  type NormalizedModuleFederationOptions,
} from '../utils/normalizeModuleFederationOptions';
import { getIsRolldown } from '../utils/packageUtils';
import { isServerBuildContext } from '../utils/remoteConsumerTarget';
import { normalizeVirtualModuleId } from '../utils/VirtualModule';
import {
  getLocalSharedImportMapPath,
  getUsedShares,
  LAZY_CONSUME_ONLY_SHARES_PLACEHOLDER,
} from '../virtualModules/virtualRemoteEntry';
import {
  getRuntimeInitGlobalKey,
  getRuntimeInitStatusImportId,
} from '../virtualModules/virtualRuntimeInitStatus';
import { getLoadShareModulePath } from '../virtualModules/virtualShared_preBuild';

/**
 * `meta.chunks` of a `renderChunk` hook, in Rollup and Rolldown alike. File names
 * still carry hash placeholders here; `imports` and `dynamicImports` use the same
 * placeholder names, so the graph is consistent within one render.
 */
type RenderedChunks = Record<string, OutputBundleItem>;

interface LazyShareGraph {
  /** Consume-only shares no startup chunk reaches through static imports. */
  lazyShares: Set<string>;
  /** Lazy shares whose wrapper sits in a chunk's static closure, by chunk file name. */
  sharesByChunk: Map<string, string[]>;
}

const chunkModuleIds = (chunk: OutputChunkWithViteMetadata) => [
  ...(chunk.facadeModuleId ? [chunk.facadeModuleId] : []),
  ...(chunk.moduleIds ?? Object.keys(chunk.modules ?? {})),
];

function buildLazyShareGraph(
  chunks: RenderedChunks,
  wrapperShares: Map<string, string>,
  exposeModules: Set<string>
): LazyShareGraph {
  const sharesInChunk = new Map<string, Set<string>>();
  const startupRoots: string[] = [];
  for (const [fileName, chunk] of Object.entries(chunks)) {
    if (chunk.type !== 'chunk') continue;
    const moduleIds = chunkModuleIds(chunk);
    sharesInChunk.set(
      fileName,
      new Set(
        moduleIds
          .map((id) => wrapperShares.get(normalizeVirtualModuleId(id)))
          .filter((share): share is string => share !== undefined)
      )
    );
    // The startup graph: every build entry plus every exposed module, followed statically.
    if (chunk.isEntry || moduleIds.some((id) => exposeModules.has(stripKnownJsExtension(id)))) {
      startupRoots.push(fileName);
    }
  }
  const sharesInClosure = (roots: string[]) =>
    new Set(
      collectStaticChunks(chunks, roots).flatMap((chunk) => [
        ...(sharesInChunk.get(chunk.fileName) ?? []),
      ])
    );
  // A share no chunk imports at all is not this plugin's business: init() keeps loading it.
  const lazyShares = new Set([...sharesInChunk.values()].flatMap((shares) => [...shares]));
  for (const share of sharesInClosure(startupRoots)) lazyShares.delete(share);
  const sharesByChunk = new Map<string, string[]>();
  if (lazyShares.size > 0) {
    for (const fileName of sharesInChunk.keys()) {
      const shares = [...sharesInClosure([fileName])].filter((share) => lazyShares.has(share));
      if (shares.length > 0) sharesByChunk.set(fileName, shares.sort());
    }
  }
  return { lazyShares, sharesByChunk };
}

// `import("./x.js")`, allowing comments (`/* webpackChunkName */`, `/* @vite-ignore */`) around the literal.
const COMMENTS = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*`;
const DYNAMIC_IMPORT_REGEX = new RegExp(
  String.raw`\bimport\(${COMMENTS}(["'` +
    '`' +
    String.raw`])([^"'` +
    '`' +
    String.raw`\n]+)\1${COMMENTS}\)`,
  'g'
);
const QUOTES = ['"', "'", '`'];

/**
 * A consume-only (`import: false`) share that only a dynamic `import()` reaches is
 * left out of `init()` and bridged when that import runs: the import expression is
 * wrapped so the share is in the cache before the chunk evaluates. There is no
 * other async boundary in an ESM graph without top-level await, so a wrapper
 * reached statically from an entry or an expose keeps loading during `init()`.
 */
export function pluginLazyConsumeOnlyShares(options: NormalizedModuleFederationOptions): Plugin {
  let viteConfig: { root?: string; build?: { ssr?: boolean | string } } | undefined;
  const graphs = new WeakMap<object, LazyShareGraph>();
  const helperName = `__mfLoadLazyShares_${options.internalName.replace(/[^A-Za-z0-9_$]/g, '_')}`;

  return {
    name: 'module-federation:lazy-consume-only-shares',
    apply: 'build',
    configResolved(config) {
      viteConfig = config as typeof viteConfig;
    },
    renderChunk(code, chunk, _outputOptions, meta) {
      const renderedChunk = chunk as unknown as OutputChunkWithViteMetadata;
      const chunks = (meta as { chunks?: RenderedChunks } | undefined)?.chunks;
      if (!chunks || Object.keys(options.exposes).length === 0) return null;
      if (isServerBuildContext(this, viteConfig)) return null;

      let graph = graphs.get(chunks);
      if (!graph) {
        const isRolldown = getIsRolldown(this);
        const wrapperShares = new Map<string, string>();
        for (const shareKey of getUsedShares(options)) {
          const shareConfig = getNormalizeShareItem(shareKey, options)?.shareConfig;
          if (shareConfig?.import !== false || shareConfig.eager || shareConfig.treeShaking)
            continue;
          wrapperShares.set(
            normalizeVirtualModuleId(getLoadShareModulePath(shareKey, isRolldown, options)),
            shareKey
          );
        }
        const root = viteConfig?.root ?? process.cwd();
        const exposeModules = new Set(
          Object.values(options.exposes).map((expose) =>
            stripKnownJsExtension(path.resolve(root, expose.import))
          )
        );
        graph = buildLazyShareGraph(chunks, wrapperShares, exposeModules);
        graphs.set(chunks, graph);
      }
      if (graph.lazyShares.size === 0) return null;

      const rewriter = new CodeRewriter(code);
      let edited = false;
      const importMapId = normalizeVirtualModuleId(getLocalSharedImportMapPath(options));
      if (
        chunkModuleIds(renderedChunk).some((id) => normalizeVirtualModuleId(id) === importMapId)
      ) {
        for (const quote of QUOTES) {
          const literal = `${quote}${LAZY_CONSUME_ONLY_SHARES_PLACEHOLDER}${quote}`;
          const start = code.indexOf(literal);
          if (start === -1) continue;
          rewriter.overwrite(
            start,
            start + literal.length,
            JSON.stringify([...graph.lazyShares].sort())
          );
          edited = true;
          break;
        }
      }

      const chunkDir = path.posix.dirname(renderedChunk.fileName);
      const codePositions = createCodePositionMap(code);
      let usesHelper = false;
      for (const match of code.matchAll(DYNAMIC_IMPORT_REGEX)) {
        const [expression, , specifier] = match;
        const start = match.index!;
        if (!codePositions[start]) continue;
        const target = path.posix.normalize(path.posix.join(chunkDir, specifier));
        const shares = graph.sharesByChunk.get(target);
        if (!shares || !renderedChunk.dynamicImports.includes(target)) continue;
        rewriter.overwrite(
          start,
          start + expression.length,
          `${helperName}(${JSON.stringify(shares)}).then(() => ${expression})`
        );
        usesHelper = edited = true;
      }
      if (!edited) return null;
      if (usesHelper) {
        const stateKey = JSON.stringify(
          getRuntimeInitGlobalKey(getRuntimeInitStatusImportId(options))
        );
        rewriter.overwrite(
          code.length,
          code.length,
          `
function ${helperName}(names) {
  const state = globalThis[${stateKey}];
  return state ? state.initPromise.then(() => (typeof state.loadLazyShares === "function" ? state.loadLazyShares(names) : undefined)) : Promise.resolve();
}
`
        );
      }
      return { code: rewriter.toString(), map: rewriter.generateMap(renderedChunk.fileName) };
    },
  };
}

export default pluginLazyConsumeOnlyShares;

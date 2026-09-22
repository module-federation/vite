import type { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { sharedCacheHelperCode } from '../utils/packageUtils';
import VirtualModule from '../utils/VirtualModule';
import { getFederationScopeKey } from './virtualModuleScope';
import { LOAD_SHARE_TAG, PREBUILD_TAG } from './shareTags';

const HELPERS_MODULE_NAME = 'loadShareHelpers';
const HELPERS_MODULE_TAG = '__mf_v__';
const HELPERS_MODULE_MARKER = `${HELPERS_MODULE_TAG}${HELPERS_MODULE_NAME}${HELPERS_MODULE_TAG}`;

// A suffix, so the chunk keeps its owning instance's prefix and two
// `federation()` instances never share one. Keeps LOAD_SHARE_TAG in the name so
// the passes that match wrapper chunks by file name still find it.
const SHARED_CHUNK_SUFFIX = `${LOAD_SHARE_TAG}shared`;

/**
 * Top-level bindings `sharedCacheHelperCode` declares, in declaration order.
 * Hoisting the helpers exports exactly these; a test keeps the list in sync
 * with the source, so a new helper fails there instead of at bundle time.
 */
export const SHARED_CACHE_HELPER_NAMES = [
  '__mfGetSharedCacheDescriptor',
  '__mfReadSharedCache',
  '__mfSharedCacheListenersKey',
  '__mfGetSharedCacheListeners',
  '__mfSubscribeSharedCache',
  '__mfSharedCacheOwnersKey',
  '__mfGetSharedCacheOwners',
  '__mfReadSharedCacheOwner',
  '__mfWriteSharedCache',
  '__mfTreeShakingSharedCacheKey',
  '__mfGetTreeShakingSharedCache',
  '__mfReadTreeShakingSharedCache',
  '__mfWriteTreeShakingSharedCache',
  '__mfTreeShakingSelectionCacheKey',
  '__mfGetTreeShakingSelectionCache',
  '__mfReadTreeShakingSharedSelection',
  '__mfWriteTreeShakingSharedSelection',
] as const;

const HELPER_EXPORT_LIST = SHARED_CACHE_HELPER_NAMES.join(', ');

const helperModules = new WeakMap<NormalizedModuleFederationOptions, VirtualModule>();

function getSharedCacheHelpersModule(options: NormalizedModuleFederationOptions): VirtualModule {
  let module = helperModules.get(options);
  if (!module) {
    module = new VirtualModule(
      HELPERS_MODULE_NAME,
      HELPERS_MODULE_TAG,
      '',
      getFederationScopeKey(options)
    );
    module.writeSync(`${sharedCacheHelperCode}\nexport { ${HELPER_EXPORT_LIST} };`);
    helperModules.set(options, module);
  }
  return module;
}

export function getSharedCacheHelpersImportCode(
  options: NormalizedModuleFederationOptions
): string {
  const importId = getSharedCacheHelpersModule(options).getImportId();
  return `import { ${HELPER_EXPORT_LIST} } from ${JSON.stringify(importId)};`;
}

export function isSharedCacheHelpersId(id: string): boolean {
  return id.includes(HELPERS_MODULE_MARKER);
}

// Derived from the id, not from the calling instance: only the last
// `federation()` instance's chunking callback survives in `codeSplitting.groups`
// and it still has to name every instance's chunk.
export function getSharedChunkName(id: string): string {
  const ownerTag = isSharedCacheHelpersId(id) ? HELPERS_MODULE_MARKER : LOAD_SHARE_TAG;
  return `${id.slice(0, id.indexOf(ownerTag))}${SHARED_CHUNK_SUFFIX}`;
}

// Matched on the name, not the file name: a share called `shared-lib` produces
// a wrapper file name that also contains `__loadShare__shared`.
export function isSharedChunk(chunk: { name?: string }): boolean {
  return chunk.name?.endsWith(SHARED_CHUNK_SUFFIX) ?? false;
}

type BundleItem = { type: string; name?: string; modules?: object };

/**
 * Fallbacks inlined into a shared chunk, which means they are no longer lazy.
 * Only inlined modules count: a shared chunk also imports fallback chunks with
 * the experiment off, because Rolldown hoists its runtime helpers into whichever
 * chunk first uses them.
 */
export function findEagerFallbacksInSharedChunk(
  bundle: Record<string, BundleItem>
): Map<string, string[]> {
  const offenders = new Map<string, string[]>();
  for (const [fileName, chunk] of Object.entries(bundle)) {
    if (chunk.type !== 'chunk' || !isSharedChunk(chunk)) continue;
    const inlined = Object.keys(chunk.modules ?? {}).filter((id) => id.includes(PREBUILD_TAG));
    if (inlined.length > 0) offenders.set(fileName, inlined);
  }
  return offenders;
}

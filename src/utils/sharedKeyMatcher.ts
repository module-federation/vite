import { getCommonSharedSubpaths } from './pathNormalization';

/**
 * Minimal shared-record shape used by both the browser matcher and SSR
 * `findVmSharedKey`. Runtime federation instances store `shareConfig.import`.
 */
export type SharedKeyLookup = Record<string, { shareConfig?: { import?: unknown } } | undefined>;

export function matchesSharedSource(source: string, key: string): boolean {
  const keyBase = key.endsWith('/') ? key.slice(0, -1) : key;
  if (
    keyBase === 'vue' &&
    (source === 'vue/dist/vue.esm-bundler.js' || source === 'vue/dist/vue.runtime.esm-bundler.js')
  ) {
    return true;
  }
  if (key.endsWith('/')) return source === keyBase || source.startsWith(`${keyBase}/`);
  if (getCommonSharedSubpaths(keyBase).includes(source)) return true;
  return source === keyBase;
}

type SharedKeyMatcher = {
  find(source: string): string | undefined;
};

const emptySharedKeyMatcher: SharedKeyMatcher = {
  find: () => undefined,
};

const sharedKeyMatcherCache = new WeakMap<object, SharedKeyMatcher>();

export function invalidateSharedKeyMatcher(shared: object): void {
  sharedKeyMatcherCache.delete(shared);
}

export function findSharedKey(
  source: string,
  shared: SharedKeyLookup | undefined
): string | undefined {
  return getSharedKeyMatcher(shared).find(source);
}

function pickLongestWildcardKey(
  wildcardKeys: Array<{ key: string; base: string }>,
  source: string
): string | undefined {
  let best: { key: string; base: string } | undefined;
  for (const wildcard of wildcardKeys) {
    if (source !== wildcard.base && !source.startsWith(`${wildcard.base}/`)) continue;
    if (
      !best ||
      wildcard.base.length > best.base.length ||
      (wildcard.base.length === best.base.length && wildcard.key.length > best.key.length)
    ) {
      best = wildcard;
    }
  }
  return best?.key;
}

function getSharedKeyMatcher(shared: SharedKeyLookup | undefined): SharedKeyMatcher {
  if (!shared) return emptySharedKeyMatcher;

  const cached = sharedKeyMatcherCache.get(shared);
  if (cached) return cached;

  // Shared matching is on a hot resolve path. Precompute exact/subpath indexes
  // once per shared object, then cache repeated source lookups.
  const keys = Object.keys(shared);
  const exactKeys = new Set(keys);
  const commonSubpathKeys = new Map<string, string>();
  const wildcardKeys: Array<{ key: string; base: string }> = [];
  let vueKey: string | undefined;

  for (const key of keys) {
    const keyBase = key.endsWith('/') ? key.slice(0, -1) : key;
    const shareItem = shared[key];

    if (!vueKey && keyBase === 'vue') vueKey = key;
    if (key.endsWith('/')) wildcardKeys.push({ key, base: keyBase });

    // `import: false` applies to the configured key only. Treating common
    // subpaths as implicit shares creates unfulfillable runtime-only entries
    // for hosts which provide the bare package but not every package export.
    if (shareItem?.shareConfig?.import !== false) {
      for (const subpath of getCommonSharedSubpaths(keyBase)) {
        if (!commonSubpathKeys.has(subpath)) commonSubpathKeys.set(subpath, key);
      }
    }
  }

  const sourceCache = new Map<string, string | undefined>();
  const matcher: SharedKeyMatcher = {
    find(source) {
      if (sourceCache.has(source)) return sourceCache.get(source);

      let result = exactKeys.has(source) ? source : undefined;

      if (!result && vueKey) {
        if (
          source === 'vue/dist/vue.esm-bundler.js' ||
          source === 'vue/dist/vue.runtime.esm-bundler.js'
        ) {
          result = vueKey;
        }
      }

      if (!result) result = commonSubpathKeys.get(source);
      if (!result) result = pickLongestWildcardKey(wildcardKeys, source);

      sourceCache.set(source, result);
      return result;
    },
  };

  sharedKeyMatcherCache.set(shared, matcher);
  return matcher;
}

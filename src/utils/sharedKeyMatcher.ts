import { getCommonSharedSubpaths } from './pathNormalization';

/**
 * Minimal shared-record shape used by both the browser matcher and SSR
 * `findVmSharedKey`. Runtime federation instances store `shareConfig.import`.
 */
export type SharedKeyLookup = Record<
  string,
  | {
      name?: string;
      shareConfig?: { import?: unknown; request?: unknown; shareKey?: unknown };
    }
  | undefined
>;

export function getSharedRequest(key: string, shareItem?: SharedKeyLookup[string]): string {
  const request = shareItem?.shareConfig?.request;
  return typeof request === 'string' ? request : key;
}

/**
 * Resolve the runtime share-scope key for a concrete request. The configured
 * property name is the default runtime key; `shareKey` only changes it when
 * explicitly provided. Prefix requests carry their concrete suffix to the
 * runtime key as required by the Module Federation shared contract.
 */
export function getSharedRuntimeKey(source: string, shareItem?: SharedKeyLookup[string]): string {
  const configuredShareKey = shareItem?.shareConfig?.shareKey;
  const request =
    typeof shareItem?.shareConfig?.request === 'string'
      ? shareItem.shareConfig.request
      : typeof shareItem?.name === 'string'
        ? shareItem.name
        : source;
  const requestMatchesSource =
    source === request ||
    (request.endsWith('/') && (source === request.slice(0, -1) || source.startsWith(request)));
  const configuredPrefixMatchesSource =
    typeof shareItem?.name === 'string' &&
    shareItem.name.endsWith('/') &&
    (source === shareItem.name.slice(0, -1) || source.startsWith(shareItem.name));
  const shareKey =
    typeof configuredShareKey === 'string'
      ? configuredShareKey
      : typeof shareItem?.name === 'string' &&
          (requestMatchesSource || configuredPrefixMatchesSource)
        ? configuredPrefixMatchesSource && !requestMatchesSource
          ? source
          : shareItem.name
        : source;
  if (!request.endsWith('/')) return shareKey;

  const requestBase = request.slice(0, -1);
  const isConcreteRequest = source === requestBase || source.startsWith(`${requestBase}/`);
  if (isConcreteRequest) return shareKey + source.slice(request.length);

  // Callers that already operate on a concrete runtime key (for example the
  // generated shared map) should remain concrete instead of being collapsed
  // back to the configured prefix.
  if (shareKey.endsWith('/') && (source === shareKey.slice(0, -1) || source.startsWith(shareKey))) {
    return source;
  }
  return shareKey;
}

export function matchesSharedSource(
  source: string,
  key: string,
  shareItem?: SharedKeyLookup[string]
): boolean {
  const request = getSharedRequest(key, shareItem);
  const keyBase = request.endsWith('/') ? request.slice(0, -1) : request;
  if (
    keyBase === 'vue' &&
    (source === 'vue/dist/vue.esm-bundler.js' || source === 'vue/dist/vue.runtime.esm-bundler.js')
  ) {
    return true;
  }
  if (request.endsWith('/')) return source === keyBase || source.startsWith(`${keyBase}/`);
  if (
    shareItem?.shareConfig?.request === undefined &&
    shareItem?.shareConfig?.shareKey === undefined &&
    getCommonSharedSubpaths(keyBase).includes(source)
  ) {
    return true;
  }
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
  const exactKeys = new Map<string, string>();
  const commonSubpathKeys = new Map<string, string>();
  const wildcardKeys: Array<{ key: string; base: string }> = [];
  let vueKey: string | undefined;

  for (const key of keys) {
    const shareItem = shared[key];
    const request = getSharedRequest(key, shareItem);
    const keyBase = request.endsWith('/') ? request.slice(0, -1) : request;

    // Preserve the historical exact-key precedence when an alias and a
    // default entry happen to target the same request.
    if (!exactKeys.has(request) || request === key) exactKeys.set(request, key);

    if (!vueKey && keyBase === 'vue') vueKey = key;
    if (request.endsWith('/')) wildcardKeys.push({ key, base: keyBase });

    // `import: false` applies to the configured key only. Treating common
    // subpaths as implicit shares creates unfulfillable runtime-only entries
    // for hosts which provide the bare package but not every package export.
    if (
      shareItem?.shareConfig?.import !== false &&
      shareItem?.shareConfig?.request === undefined &&
      shareItem?.shareConfig?.shareKey === undefined
    ) {
      for (const subpath of getCommonSharedSubpaths(keyBase)) {
        if (!commonSubpathKeys.has(subpath)) commonSubpathKeys.set(subpath, key);
      }
    }
  }

  const sourceCache = new Map<string, string | undefined>();
  const matcher: SharedKeyMatcher = {
    find(source) {
      if (sourceCache.has(source)) return sourceCache.get(source);

      let result = exactKeys.get(source);

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

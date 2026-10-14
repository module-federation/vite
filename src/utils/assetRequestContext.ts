/// <reference lib="dom" />
/**
 * `assetRequestContext` support for the Vite bundler runtime.
 *
 * Consumer side: the application writes its own runtime plugin. Its `fetch` hook
 * sends manifest requests through `request`, its `loadEntry` hook loads ESM remote
 * entries with `loadEntryWithRequest`, and its `beforeInitContainer` hook hands the
 * context to each container through `remoteEntryInitOptions.assetRequestContext`.
 *
 * Producer side: every browser remote entry registers
 * `assetRequestContextProducerPlugin`. The entry's `init()` passes the context it
 * received to its own MF instance, where the plugin installs it in `beforeInit`.
 * The entry's and exposes' chunks, their dependencies and expose CSS are then
 * fetched through `request` and evaluated from blob URLs (see blobLoad.ts).
 * Without a context the native import path is used.
 */
import type {
  ModuleFederationRuntimePlugin,
  RemoteEntryExports,
} from '@module-federation/runtime/types';
import {
  createOrGetBlobLoaderContexts,
  loadCssWithFetch,
  loadEsmEntryWithFetch,
  type BlobLoaderContext,
} from './blobLoad';

/** Mirrors `AssetRequestContext` in `@module-federation/runtime-core`. */
export interface AssetRequestContext {
  /**
   * Identifies the consumer that provided this context. A container shared by
   * several consumers refuses a context from a different `consumerId` instead of
   * replacing the first consumer's.
   */
  consumerId?: string;
  /**
   * Performs a request for one of the container's assets, for example to
   * attach an `Authorization` header. Called per request so tokens can be
   * refreshed.
   */
  request?: (url: string, init?: RequestInit) => Promise<Response>;
}

// Mirrors `Options.assetRequestContext` in `@module-federation/runtime-core`,
// which the runtime versions this package supports do not declare yet.
type WithAssetRequestContext = { assetRequestContext?: AssetRequestContext };

// Producer state. Each remote build bundles its own copy of this module, so the
// state belongs to one container.
const producerModuleUrls = new Set<string>();
let producerContext: AssetRequestContext | undefined;

function toBlobLoaderContext(context: AssetRequestContext): BlobLoaderContext {
  return { customFetch: context.request };
}

// The vite preload helper adds native <link> preloads for a chunk's dependencies.
// Those cannot carry headers, so their failures are ignored; the chunks themselves
// are fetched through assetRequestContext.request.
const ignoreVitePreloadError = (e: Event) => e.preventDefault();

/**
 * Called at the top level of the remote entry and exposes modules with their own
 * `import.meta.url`. Dynamic imports in those chunks go through the blob loader
 * once their url has a context in the shared registry.
 */
export function registerProducerModule(url: string): void {
  producerModuleUrls.add(url);
  const contexts = createOrGetBlobLoaderContexts();
  if (producerContext) contexts.set(url, toBlobLoaderContext(producerContext));
}

/**
 * Installs the context a consumer passed to this container. Returns the context
 * the container uses after this call.
 */
export function installAssetRequestContext(
  context?: AssetRequestContext
): AssetRequestContext | undefined {
  if (!context?.request || context === producerContext) return producerContext;
  if (producerContext && producerContext.consumerId !== context.consumerId) {
    console.warn(
      `[Module Federation] Ignoring assetRequestContext from consumer "${context.consumerId}": ` +
        `this container already uses the one from consumer "${producerContext.consumerId}".`
    );
    return producerContext;
  }
  producerContext = context;
  const contexts = createOrGetBlobLoaderContexts();
  for (const url of producerModuleUrls) contexts.set(url, toBlobLoaderContext(context));
  if (typeof window !== 'undefined') {
    window.addEventListener('vite:preloadError', ignoreVitePreloadError);
  }
  return producerContext;
}

/**
 * Producer runtime plugin, registered by every browser remote entry. The entry's
 * `init()` passes `remoteEntryInitOptions.assetRequestContext` to its MF instance,
 * and this plugin installs it in `beforeInit`.
 */
export function assetRequestContextProducerPlugin(): ModuleFederationRuntimePlugin {
  return {
    name: 'vite-asset-request-context-producer-plugin',
    beforeInit(args) {
      const userOptions = args.userOptions as WithAssetRequestContext;
      if (!userOptions.assetRequestContext) return args;
      // The instance stores this userOptions object, not the one beforeInit
      // returns, so a refused context is replaced in place.
      const installed = installAssetRequestContext(userOptions.assetRequestContext);
      if (installed) {
        userOptions.assetRequestContext = installed;
      } else {
        delete userOptions.assetRequestContext;
      }
      return args;
    },
  };
}

/**
 * Loads an expose's CSS through `assetRequestContext.request` when the container
 * has a context. Returns undefined when it has none, so the caller adds a plain
 * <link>.
 */
export function loadCssWithAssetRequestContext(href: string): Promise<void> | undefined {
  if (!producerContext?.request) return undefined;
  return loadCssWithFetch({ href, customFetch: producerContext.request });
}

export function hasAssetRequestContext(): boolean {
  return !!producerContext?.request;
}

/** Test helper: forget the producer state. */
export function resetAssetRequestContext(): void {
  producerContext = undefined;
  producerModuleUrls.clear();
}

/**
 * Loads a `module`/`esm` remote entry through `request`, for a consumer's
 * `loadEntry` hook. Relative imports and `import.meta.url` in the entry and its
 * chunks keep pointing at the remote's real URLs. Failures carry RUNTIME-008, so
 * `loadEntryError` recovery still runs.
 */
export function loadEntryWithRequest({
  entry,
  name,
  request,
}: {
  entry: string;
  name: string;
  request: NonNullable<AssetRequestContext['request']>;
}): Promise<RemoteEntryExports> {
  return loadEsmEntryWithFetch({ entry, name, customFetch: request });
}

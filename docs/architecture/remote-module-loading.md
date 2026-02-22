# Remote Module Loading — Deep Dive

## Contents

- [What remote loading means](#what-remote-loading-means)
- [Remote config formats and normalization](#remote-config-formats-and-normalization)
- [How remote imports are intercepted](#how-remote-imports-are-intercepted)
- [Tracing a single import: `shop/Cart` from source to runtime](#tracing-a-single-import-shopcart-from-source-to-runtime)
- [The `__loadRemote__` virtual module](#the-__loadremote__-virtual-module)
  - [Build mode](#build-mode)
  - [Dev mode](#dev-mode)
- [How remote metadata gets into `remoteEntry.js`](#how-remote-metadata-gets-into-remoteentryjs)
- [The exposing side: how `exposes` works](#the-exposing-side-how-exposes-works)
  - [The `exposesMap`](#the-exposesmap)
  - [The `get()` function](#the-get-function)
- [Dev vs Build: the full picture](#dev-vs-build-the-full-picture)
  - [How `remoteEntry.js` is served in dev mode](#how-remoteentryjs-is-served-in-dev-mode)
  - [How `hostInit` works in dev mode](#how-hostinit-works-in-dev-mode)
- [The `var` remote entry: legacy host support](#the-var-remote-entry-legacy-host-support)
- [Relationship to shared dependencies](#relationship-to-shared-dependencies)

## What remote loading means

Remote loading is one half of Module Federation's core value (the other being [shared dependencies](./shared-dependency-resolution.md)). It lets one app import modules from another app at runtime, without either app needing to know about the other at build time beyond a URL.

```
┌─────────────────────────────┐                ┌─────────────────────────────┐
│         Host App            │                │        Remote App           │
│                             │                │                             │
│  import('shop/Cart')        │   HTTP fetch   │  exposes: {                 │
│         │                   │ ──────────────>│    './Cart': './src/Cart'   │
│         ▼                   │                │  }                          │
│  runtime.loadRemote(        │                │                             │
│    'shop/Cart'              │                │  remoteEntry.js             │
│  )                          │                │    ├── init(shared)         │
│         │                   │                │    └── get('./Cart')        │
│         ▼                   │                │          └── () => Cart     │
│  Cart component renders     │                │                             │
└─────────────────────────────┘                └─────────────────────────────┘
```

The host never bundles the remote's code. Instead, at runtime, the federation runtime fetches the remote's `remoteEntry.js`, calls `init()` to negotiate shared deps, then calls `get('./Cart')` to retrieve the actual module.

## Remote config formats and normalization

Remotes can be configured in two ways. Both are normalized by `normalizeRemoteItem()` in `src/utils/normalizeModuleFederationOptions.ts` into a `RemoteObjectConfig`.

### String format (shorthand)

```js
federation({
  remotes: {
    shop: 'shopApp@https://shop.example.com/remoteEntry.js',
  },
});
```

The string is parsed as `{entryGlobalName}@{entry}`:

```
"shopApp@https://shop.example.com/remoteEntry.js"
    │                    │
    ▼                    ▼
entryGlobalName    entry (URL)
= "shopApp"        = "https://shop.example.com/remoteEntry.js"
```

After normalization:

```js
{
  type: 'var',
  name: 'shop',              // the key from your config — used as the import prefix
  entry: 'https://shop.example.com/remoteEntry.js',
  entryGlobalName: 'shopApp', // the part before @
  shareScope: 'default',
}
```

### Object format (explicit)

```js
federation({
  remotes: {
    shop: {
      type: 'module',
      name: 'shop',
      entry: 'https://shop.example.com/remoteEntry.js',
      entryGlobalName: 'shopApp',
    },
  },
});
```

This is merged with defaults (`type: 'var'`, `shareScope: 'default'`).

### What each field means

| Field             | Purpose                                                                             |
| ----------------- | ----------------------------------------------------------------------------------- |
| `name`            | The key used in your config. This is the import prefix: `import('shop/Cart')`       |
| `entry`           | URL where the remote's `remoteEntry.js` can be fetched                              |
| `entryGlobalName` | For `var` type: the global variable name the remote exposes itself as               |
| `type`            | How the remote entry is loaded: `'var'` (script tag), `'module'` (ESM import), etc. |
| `shareScope`      | Which shared scope to use for dependency negotiation (almost always `'default'`)    |

## How remote imports are intercepted

Remote import interception is simpler than shared dependency interception. There's only one alias, and it uses the same pattern as the shared deps system: a Vite `resolve.alias` with a `customResolver`.

The `pluginProxyRemotes` plugin (`src/plugins/pluginProxyRemotes.ts`) registers one alias per remote during the `config` hook:

```js
// For each remote in the config:
{
  find: new RegExp(`^(shop(\/.*|$))`),   // matches 'shop', 'shop/Cart', 'shop/anything'
  replacement: '$1',
  customResolver(source) {
    const remoteModule = getRemoteVirtualModule(source, command);
    addUsedRemote(remote.name, source);
    return remoteModule.getPath();
  }
}
```

The regex `^(shop(\/.*|$))` matches the remote name with any subpath — so `shop`, `shop/Cart`, and `shop/components/Button` all match. Unlike shared deps (where the trailing slash matters), remote aliases always match subpaths because you always import _from_ a remote, not the remote itself.

The `customResolver` does two things:

1. Creates (or retrieves from cache) a `__loadRemote__` virtual module for this specific import path
2. Tracks the usage in `usedRemotesMap` so the remote's metadata gets included in `remoteEntry.js`

## Tracing a single import: `shop/Cart` from source to runtime

Given this config:

```js
federation({
  name: 'host',
  remotes: {
    shop: 'shopApp@https://shop.example.com/remoteEntry.js',
  },
});
```

Here's what happens when Vite encounters `import('shop/Cart')`:

```
 Your source code              Plugin alias              Virtual module on disk
┌──────────────────────┐    ┌─────────────────────┐    ┌────────────────────────────────┐
│                      │    │ pluginProxyRemotes   │    │ __loadRemote__/shop/Cart       │
│ import('shop/Cart')  │───>│                      │───>│                                │
│                      │    │ regex: ^(shop(\/.*)) │    │ awaits initPromise, then calls │
└──────────────────────┘    │ customResolver →     │    │ runtime.loadRemote('shop/Cart')│
                            │ getRemoteVirtualModule│    │                                │
                            └─────────────────────┘    └────────────────────────────────┘
                                                                     │
                                                                     │ at runtime
                                                                     ▼
                                                       ┌────────────────────────────────┐
                                                       │ @module-federation/runtime      │
                                                       │                                │
                                                       │ 1. Fetches shop's remoteEntry  │
                                                       │ 2. Calls remoteEntry.init()    │
                                                       │ 3. Calls remoteEntry.get(      │
                                                       │      './Cart')                 │
                                                       │ 4. Returns the Cart module     │
                                                       └────────────────────────────────┘
```

Step by step:

1. **Vite resolves `'shop/Cart'`** — the alias registered by `pluginProxyRemotes` matches via regex `^(shop(\/.*|$))`
2. **`customResolver` fires** — calls `getRemoteVirtualModule('shop/Cart', command)` which creates a `VirtualModule` with tag `__loadRemote__` and writes the generated code to disk. Also calls `addUsedRemote('shop', 'shop/Cart')` to track usage.
3. **Vite resolves to the virtual module path** — something like `node_modules/__mf__virtual/host__loadRemote__shop_mf_1_Cart__loadRemote__.js` (slashes encoded as `_mf_1_` by `packageNameEncode()`)
4. **In build mode**, the `module-federation-esm-shims` plugin adds `syntheticNamedExports` (same as for shared deps — see [shared deps doc](./shared-dependency-resolution.md#the-esm-shims-making-proxied-modules-work-with-named-imports))
5. **At runtime** — `initPromise` resolves, then `runtime.loadRemote('shop/Cart')` fetches the remote's entry, initializes it, and returns the module

## The `__loadRemote__` virtual module

The virtual module is generated by `generateRemotes()` in `src/virtualModules/virtualRemotes.ts`. Like shared deps, it has different formats for build and dev.

### Build mode

```js
import { initPromise } from '__mf__virtual/host__mf_v__runtimeInit__mf_v__';
const res = initPromise.then((runtime) => runtime.loadRemote('shop/Cart'));
const exportModule = await initPromise.then((_) => res);
export default exportModule;
```

The double reference to `initPromise` is intentional:

- `res` starts loading the remote as soon as init completes
- `exportModule` awaits `initPromise` again then awaits `res` — this ensures the module isn't exported until both init is done and the remote has been loaded

### Dev mode

```js
const { initPromise } = require('__mf__virtual/host__mf_v__runtimeInit__mf_v__');
const res = initPromise.then((runtime) => runtime.loadRemote('shop/Cart'));
const exportModule = /*mf top-level-await placeholder replacement mf*/ initPromise.then((_) => res);
module.exports = exportModule;
```

Same CJS + placeholder pattern as shared deps. The `require()` and placeholder comment are needed because these virtual modules go through Vite's pre-bundling pipeline (they live in `node_modules/__mf__virtual/`), and the pre-bundling interop wrappers are synchronous. See the [shared deps doc](./shared-dependency-resolution.md#why-cjs-in-dev-mode) for the full explanation.

`pluginDevProxyModuleTopLevelAwait` later transforms the exports to properly await the promise.

### Caching

Each unique import path gets its own virtual module, created once and cached in `cacheRemoteMap`:

```js
const cacheRemoteMap: { [remote: string]: VirtualModule } = {};

export function getRemoteVirtualModule(remote: string, command: string) {
  if (!cacheRemoteMap[remote]) {
    cacheRemoteMap[remote] = new VirtualModule(remote, LOAD_REMOTE_TAG, '.js');
    cacheRemoteMap[remote].writeSync(generateRemotes(remote, command));
  }
  return cacheRemoteMap[remote];
}
```

So `import('shop/Cart')` and `import('shop/Button')` get separate virtual modules, each calling `runtime.loadRemote()` with their respective path. But `import('shop/Cart')` appearing in two different files resolves to the same virtual module.

## How remote metadata gets into `remoteEntry.js`

When the alias resolver fires, it calls `addUsedRemote(remote.name, source)` which tracks which remotes are actually used. This feeds into the `localSharedImportMap` (generated by `generateLocalSharedImportMap()` in `src/virtualModules/virtualRemoteEntry.ts`), which produces a `usedRemotes` array:

```js
const usedRemotes = [
  {
    entryGlobalName: 'shopApp',
    name: 'shop',
    type: 'var',
    entry: 'https://shop.example.com/remoteEntry.js',
    shareScope: 'default',
  },
];
```

This array is imported by the generated `remoteEntry.js` and passed to `runtimeInit()`:

```js
import { usedShared, usedRemotes } from '<localSharedImportMapPath>';

const initRes = runtimeInit({
  name: 'host',
  remotes: usedRemotes, // ← tells the runtime where to find remote apps
  shared: usedShared,
  // ...
});
```

The runtime uses this metadata to know where to fetch each remote's `remoteEntry.js` when `loadRemote()` is called.

Only actually-used remotes are included. If you declare a remote in your config but never import from it, it won't appear in `usedRemotes` and the runtime won't try to load it.

## The exposing side: how `exposes` works

So far we've covered the host side (consuming remote modules). Here's how the remote side (exposing modules) works.

### The `exposesMap`

When a remote declares `exposes`, the plugin generates a virtual module (`virtual:mf-exposes`) containing a map of expose names to async import functions. Generated by `generateExposes()` in `src/virtualModules/virtualExposes.ts`:

```js
// Given config: exposes: { './Cart': './src/Cart.vue' }
// Generated code:
export default {
  './Cart': async () => {
    const importModule = await import('./src/Cart.vue');
    const exportModule = {};
    Object.assign(exportModule, importModule);
    Object.defineProperty(exportModule, '__esModule', {
      value: true,
      enumerable: false,
    });
    return exportModule;
  },
};
```

Each exposed module is lazily loaded — the import only happens when someone calls `get('./Cart')`. The `__esModule` property is added for CJS/ESM interop.

### The `get()` function

The `get()` function in the generated `remoteEntry.js` (produced by `generateRemoteEntry()` in `src/virtualModules/virtualRemoteEntry.ts`) looks up the expose name in the map and returns a factory:

```js
import exposesMap from 'virtual:mf-exposes';

function getExposes(moduleName) {
  if (!(moduleName in exposesMap))
    throw new Error(`Module ${moduleName} does not exist in container.`);
  return exposesMap[moduleName]().then((res) => () => res);
}

export { init, getExposes as get };
```

The return type is `Promise<() => module>` — a promise that resolves to a factory function. The factory pattern is a Module Federation convention that allows lazy initialization.

```
Host calls                      Remote's remoteEntry.js
──────────                      ───────────────────────
get('./Cart')              →    exposesMap['./Cart']()
                                      │
                                      ▼
                                import('./src/Cart.vue')
                                      │
                                      ▼
                                returns () => CartModule
```

## Dev vs Build: the full picture

### How `remoteEntry.js` is served in dev mode

In build mode, `remoteEntry.js` is emitted as a Rollup chunk via `pluginAddEntry`. In dev mode, it's served through middleware.

The `pluginAddEntry` serve plugin registers middleware on Vite's dev server (`configureServer` hook):

```js
server.middlewares.use((req, res, next) => {
  if (req.url && req.url.startsWith('/remoteEntry-[hash]')) {
    req.url = devEntryPath; // redirect to the virtual module path
  }
  next();
});
```

When a host app requests the remote's `remoteEntry.js` URL, the middleware redirects the request to the virtual module path (`@id/virtual:mf-REMOTE_ENTRY_ID`), which Vite's dev server then resolves and serves through the normal plugin pipeline.

The `pluginProxyRemoteEntry` plugin handles the actual code generation via its `resolveId`/`load`/`transform` hooks — the same plugin is used for both build and dev, but in dev mode `parsePromise` resolves immediately (no module-parse tracking), so the code is generated synchronously.

### How `hostInit` works in dev mode

In build mode, `hostInit` is a chunk that imports `remoteEntry.js` and calls `init()`. In dev mode, `pluginProxyRemoteEntry` generates a different script in its `transform` hook:

```js
const origin = window && true ? window.origin : '//localhost:5173';
const remoteEntryPromise = await import(origin + '/remoteEntry-[hash]');
Promise.resolve(remoteEntryPromise).then((remoteEntry) => {
  return Promise.resolve(remoteEntry.__tla).then(remoteEntry.init).catch(remoteEntry.init);
});
```

This dynamically imports the remoteEntry from the dev server's origin and calls `init()`. The `__tla` handling is a compatibility shim for `vite-plugin-top-level-await` — it waits for any TLA promise before calling init, or calls init anyway if there's no TLA.

The `hostInit` script is injected into the page via one of two methods, controlled by the `hostInitInjectLocation` option:

- **`'html'`** (default): `transformIndexHtml` inserts a `<script type="module">` tag into `<head>`
- **`'entry'`**: The script is imported at the top of your entry file via the `transform` hook

## The `var` remote entry: legacy host support

By default, the plugin generates an ESM `remoteEntry.js` (using `export { init, get }`). But some host environments (older webpack builds, non-ESM setups) expect a "var" format where the remote exposes itself as a global variable.

If `varFilename` is set in the config, `pluginVarRemoteEntry` (`src/plugins/pluginVarRemoteEntry.ts`) generates an additional file that wraps the ESM entry in an IIFE:

```js
var shopApp;
shopApp = (function () {
  function getScriptUrl() {
    const currentScript = document.currentScript;
    if (!currentScript) {
      console.error('...');
      return '/';
    }
    return document.currentScript.src.replace(/\/[^/]*$/, '/');
  }

  const entry = getScriptUrl() + 'remoteEntry-abc123.js';

  return {
    get: (...args) => import(entry).then((m) => m.get(...args)),
    init: (...args) => import(entry).then((m) => m.init(...args)),
  };
})();
```

This creates a global variable (`shopApp` or `globalThis['shop-app']` if the name isn't a valid JS identifier) that proxies `get()` and `init()` calls to the real ESM remoteEntry via dynamic import. The URL is resolved relative to the script's own location using `document.currentScript.src`.

In dev mode, the var entry is served via middleware that generates the same wrapper pointing at the dev server's remoteEntry filename.

## Relationship to shared dependencies

Remote loading and shared dependency resolution are separate systems, but they connect at initialization time:

```
                    ┌──────────────────────┐
                    │   remoteEntry.init()  │
                    │                      │
                    │  Registers:          │
                    │  ├── usedRemotes     │──── where to find other apps
                    │  └── usedShared      │──── what deps this app provides
                    │                      │
                    │  Then:               │
                    │  initShareScopeMap() │──── negotiates shared dep versions
                    │  initializeSharing() │     with all connected apps
                    │                      │
                    │  Finally:            │
                    │  initResolve()       │──── unblocks all __loadShare__
                    │                      │     and __loadRemote__ modules
                    └──────────────────────┘
```

Both `__loadShare__` and `__loadRemote__` virtual modules await the same `initPromise`. This means:

1. The app's `hostInit` runs and calls `remoteEntry.init()`
2. `init()` registers both shared deps and remote entries with the runtime
3. `init()` negotiates shared dep versions
4. `initResolve()` fires — both shared and remote modules can now load
5. `loadShare()` calls resolve with the negotiated dependency versions
6. `loadRemote()` calls resolve by fetching remote entries and calling their `get()` functions

The shared negotiation must happen before remote modules load, because remote modules may themselves use shared deps. The `initPromise` ensures this ordering.

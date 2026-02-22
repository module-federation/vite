# Shared Dependency Resolution — Deep Dive

## Contents

- [Why shared dependencies need special handling](#why-shared-dependencies-need-special-handling)
- [The two virtual module types: `__loadShare__` and `__prebuild__`](#the-two-virtual-module-types-__loadshare__-and-__prebuild__)
- [Tracing a single import: `react` from source to runtime](#tracing-a-single-import-react-from-source-to-runtime)
- [Subpath imports: `react-dom/client` and the trailing slash](#subpath-imports-react-domclient-and-the-trailing-slash)
- [How aliases are registered](#how-aliases-are-registered)
  - [Alias Set 1: intercept bare imports](#alias-set-1-intercept-bare-imports--__loadshare__)
  - [Alias Set 2: resolve `__prebuild__` → real package](#alias-set-2-resolve-__prebuild__--real-package)
- [File generation: what gets written to disk and when](#file-generation-what-gets-written-to-disk-and-when)
- [The `localSharedImportMap` and how it feeds into `remoteEntry.js`](#the-localsharedimportmap-and-how-it-feeds-into-remoteentryjs)
- [Dev vs Build: where the behavior diverges](#dev-vs-build-where-the-behavior-diverges)
  - [Why CJS in dev mode?](#why-cjs-in-dev-mode)
  - [The PromiseStore in dev mode](#the-promisestore-in-dev-mode)
- [Runtime negotiation: what `loadShare()` actually does](#runtime-negotiation-what-loadshare-actually-does)
- [The ESM shims: making proxied modules work with named imports](#the-esm-shims-making-proxied-modules-work-with-named-imports)

## Why shared dependencies need special handling

Module Federation's core value is deduplication — two apps sharing `react` should use one copy, not two. But Vite bundles each app's dependencies independently. If two micro-frontends each bundle their own React, you get two copies in the browser: doubled memory, broken context, broken hooks.

The plugin solves this by intercepting every import of a shared dependency and replacing it with a runtime call that asks: "does anyone else already have this package loaded? If so, use theirs. If not, use mine."

This creates a fundamental tension: the decision of _which_ copy to use can only happen at runtime (when we know what other apps are loaded), but Vite needs to resolve and bundle imports at build time. The plugin bridges this gap by generating proxy modules that defer the real resolution to runtime while still giving Vite something concrete to bundle.

## The two virtual module types: `__loadShare__` and `__prebuild__`

Every shared dependency gets split into two virtual modules on disk. They serve different purposes and both are required.

```
                          ┌──────────────────────────────────┐
                          │  __loadShare__/react             │
                          │                                  │
  import React from       │  "Ask the runtime for the best   │
  'react'                 │   available version of react.    │
  ──────────────────>     │   If the host has react@18.2,    │
  (alias intercepts)      │   use that. Otherwise, fall back │
                          │   to __prebuild__."              │
                          └──────────┬───────────────────────┘
                                     │
                                     │ (fallback path)
                                     ▼
                          ┌──────────────────────────────────┐
                          │  __prebuild__/react              │
                          │                                  │
                          │  "This app's own bundled copy    │
                          │   of react. The version we       │
                          │   contribute to the shared pool."│
                          └──────────────────────────────────┘
```

- **`__loadShare__`** is the proxy — it calls `runtime.loadShare('react')` which negotiates with other apps at runtime to find the best version.
- **`__prebuild__`** is this app's local copy — the version bundled from your `node_modules`. The runtime needs access to it even if it ultimately decides to use a version from another app, because _somebody_ has to provide the module. This is what your app contributes to the pool.

Both are defined in `src/virtualModules/virtualShared_preBuild.ts`.

## Tracing a single import: `react` from source to runtime

Given this config:

```js
// vite.config.ts
federation({
  name: 'host',
  shared: ['react'],
});
```

Here's what happens when Vite encounters `import React from 'react'` during build:

```
 Your source code           Alias #1                 Alias #2
┌──────────────────┐    ┌───────────────────┐    ┌──────────────────────┐
│                  │    │  __loadShare__    │    │                      │
│ import React     │───>│  /react           │───>│  __prebuild__/react  │──> real react in
│ from 'react'     │    │                   │    │  (empty placeholder) │    node_modules/
│                  │    │ calls runtime.    │    │                      │
└──────────────────┘    │ loadShare('react')│    └──────────────────────┘
                        │ which may use the │
                        │ prebuild as its   │
                        │ fallback          │
                        └───────────────────┘
```

Step by step:

1. **Vite resolves `'react'`** — hits Alias Set 1 (regex: `^react$`), registered in the `config` hook of `proxySharedModule()` in `src/plugins/pluginProxySharedModule_preBuild.ts`
2. **Custom resolver fires** — calls `getLoadShareModulePath('react')`, writes the `__loadShare__` virtual module to disk, writes the `__prebuild__` placeholder to disk, adds `'react'` to the used-shares set, and regenerates the `localSharedImportMap`
3. **Vite bundles the `__loadShare__` module** — this module imports `__prebuild__/react` (as a side-effect to ensure it's in the bundle) and calls `runtime.loadShare('react')`
4. **Vite resolves `__prebuild__/react`** — hits Alias Set 2 (regex: `.*__prebuild__.*`), also registered in `proxySharedModule()`
5. **Second alias resolves back to `'react'`** — extracts the package name via `assertModuleFound()` and returns it, so Vite bundles the real react from `node_modules`
6. **At runtime** — `loadShare('react')` asks the federation runtime: "who has react, and which version should we use?" The runtime picks the best match and returns it

## Subpath imports: `react-dom/client` and the trailing slash

A common pattern in modern React is:

```js
import { createRoot } from 'react-dom/client';
```

How this is handled depends on how `react-dom` is declared in the `shared` config. The regex generated for each shared key is different depending on whether the key ends with a trailing slash.

### Without trailing slash (exact match only)

```js
shared: ['react-dom'];
// Generated regex: (^react-dom$)
```

This only matches the exact string `react-dom`. The import `react-dom/client` does **not** match, so it bypasses the shared dependency system entirely and gets bundled normally by Vite. No `__loadShare__` module is created, no runtime negotiation happens for this import.

### With trailing slash (matches subpaths)

```js
shared: ['react-dom/'];
// Generated regex: (^react-dom(\/.*)?$)
```

This matches both `react-dom` and `react-dom/client` (and any other subpath). When `react-dom/client` hits the alias:

```
import { createRoot }       Alias Set 1                      Alias Set 2
from 'react-dom/client'     regex: (^react-dom(\/.*)?$)      regex: (.*__prebuild__.*)
        │                          │                                │
        ▼                          ▼                                ▼
  source = 'react-dom/client'     __loadShare__ module          __prebuild__ module
  (full subpath preserved)        calls loadShare(               resolves back to
                                   'react-dom/client')           'react-dom/client'
```

The subpath survives the entire chain because:

1. **The `customResolver` receives the full source** — `'react-dom/client'`, not `'react-dom'`
2. **`getLoadShareModulePath('react-dom/client')`** creates a `VirtualModule` with `name = 'react-dom/client'`
3. **The `/` is encoded** by `packageNameEncode()` in `src/utils/packageNameUtils.ts` as `_mf_1_`, so the filename is valid: `host__loadShare__react_mf_2_dom_mf_1_client__loadShare__.js`
4. **`writeLoadShareModule` passes the full subpath** to `runtime.loadShare('react-dom/client', ...)`
5. **Alias Set 2** extracts the package name via `VirtualModule.findModule()`, which decodes `_mf_1_` back to `/`, recovering `'react-dom/client'`

The runtime receives `'react-dom/client'` and negotiates at the subpath level.

### Which should you use?

For packages where subpath imports are common (`react-dom/client`, `react-dom/server`, `@mui/material/Button`), use the trailing slash form. Otherwise the subpath imports silently fall through to normal bundling and won't be shared.

```js
// Good — shares both react-dom and react-dom/client
shared: ['react-dom/'];

// Incomplete — react-dom/client won't be shared
shared: ['react-dom'];
```

## How aliases are registered

All alias registration happens in the `config` hook of the `proxyPreBuildShared` plugin, inside the `proxySharedModule()` function in `src/plugins/pluginProxySharedModule_preBuild.ts`. It pushes two sets of aliases onto `config.resolve.alias`.

### Alias Set 1: intercept bare imports → `__loadShare__`

For each key in the `shared` config, an alias is registered with a regex and custom resolver:

```js
{
  find: new RegExp(`(^react$)`),   // exact match for 'react'
  replacement: '$1',
  customResolver(source, importer) {
    if (/\.css$/.test(source)) return;           // skip CSS imports
    const loadSharePath = getLoadShareModulePath(source);  // get/create virtual module
    writeLoadShareModule(source, shared[key], command);     // write code to disk
    writePreBuildLibPath(source);                           // write empty __prebuild__ file
    addUsedShares(source);                                  // track that react is used
    writeLocalSharedImportMap();                            // regenerate metadata
    return this.resolve(loadSharePath, importer);           // resolve to virtual module path
  }
}
```

The `customResolver` does all the work — it's not just resolving, it's generating files on the fly. Every time Vite encounters an import of a shared dep, this resolver writes (or updates) the virtual modules and metadata.

For packages with trailing slashes (like `react-dom/`), the regex changes to match subpaths too: `(^react-dom(\/.*)?$)`.

### Alias Set 2: resolve `__prebuild__` → real package

This alias behaves differently in build vs dev.

**Build mode** (the `replacement` function branch in `proxySharedModule()`):

```js
{
  find: new RegExp(`(.*__prebuild__.*)`),
  replacement: function ($1) {
    const module = assertModuleFound(PREBUILD_TAG, $1);  // find the VirtualModule instance
    return module.name;                                   // return 'react' — the real package name
  }
}
```

Rollup then resolves `'react'` normally to `node_modules/react`.

**Dev mode** (the `customResolver` branch in `proxySharedModule()`):

```js
{
  find: new RegExp(`(.*__prebuild__.*)`),
  replacement: '$1',
  async customResolver(source, importer) {
    const module = assertModuleFound(PREBUILD_TAG, source);
    const pkgName = module.name;
    const result = await this.resolve(pkgName, importer).then(item => item.id);
    if (!result.includes(_config.cacheDir)) {
      savePrebuild.set(pkgName, Promise.resolve(result));  // cache non-prebundled path
    }
    return await this.resolve(await savePrebuild.get(pkgName), importer);
  }
}
```

The dev mode resolver uses a `PromiseStore` (see [PromiseStore section](#the-promisestore-in-dev-mode)) because Vite's dev server pre-bundles dependencies into its cache directory. The first resolution might return a path inside `.vite/deps/` (the pre-bundle cache), but the resolver needs the original path for the `localSharedImportMap` to work correctly.

## File generation: what gets written to disk and when

Files are written lazily — not upfront, but when the alias resolver first encounters each shared dependency. This happens in the `customResolver` of Alias Set 1.

### The `__loadShare__` file

Generated by `writeLoadShareModule()` in `src/virtualModules/virtualShared_preBuild.ts`.

For `react` in build mode, the file written to `node_modules/__mf__virtual/host__loadShare__react__loadShare__.js` contains:

```js
// Side-effect import to ensure __prebuild__/react is in the bundle graph
() => import('__mf__virtual/host__prebuild__react__prebuild__').catch(() => {});

// Wait for federation to initialize, then ask runtime for the best react
import { initPromise } from '__mf__virtual/host__mf_v__runtimeInit__mf_v__';
const res = initPromise.then((runtime) =>
  runtime.loadShare('react', {
    customShareInfo: {
      shareConfig: {
        singleton: false,
        strictVersion: false,
        requiredVersion: '^18.2.0',
      },
    },
  })
);
const exportModule = await res.then((factory) => factory());
export default exportModule;
```

In dev mode, the same file uses CJS and a placeholder:

```js
() => import('__mf__virtual/host__prebuild__react__prebuild__').catch(() => {});
() => import('react').catch(() => {}); // extra hint for dev pre-bundling
const { initPromise } = require('__mf__virtual/host__mf_v__runtimeInit__mf_v__');
const res = initPromise.then((runtime) =>
  runtime.loadShare('react', {
    customShareInfo: {
      shareConfig: {
        singleton: false,
        strictVersion: false,
        requiredVersion: '^18.2.0',
      },
    },
  })
);
const exportModule = /*mf top-level-await placeholder replacement mf*/ res.then((factory) =>
  factory()
);
module.exports = exportModule;
```

The `/*mf top-level-await placeholder replacement mf*/` comment is later replaced by `pluginDevProxyModuleTopLevelAwait` (see the [overview doc](./overview.md#the-cjs--placeholder-pattern) for details on this transform).

### The `__prebuild__` file

Generated by `writePreBuildLibPath()` in `src/virtualModules/virtualShared_preBuild.ts`.

This file is written **empty**:

```js
writePreBuildLibPath(pkg) {
  if (!preBuildCacheMap[pkg])
    preBuildCacheMap[pkg] = new VirtualModule(pkg, PREBUILD_TAG);
  preBuildCacheMap[pkg].writeSync('');  // empty file
}
```

It's a placeholder. The file needs to exist on disk so Vite's dependency optimizer can discover it, but its content doesn't matter — when Vite actually resolves an import of this path, Alias Set 2 intercepts it and redirects to the real package in `node_modules`.

### The `localSharedImportMap`

Generated by `writeLocalSharedImportMap()` in `src/virtualModules/virtualRemoteEntry.ts`.

This file is regenerated every time a new shared dep is encountered. The check is simple — it only rewrites when the count changes:

```js
let prevSharedCount: number | undefined;
export function writeLocalSharedImportMap() {
  const sharedCount = getUsedShares().size;
  if (prevSharedCount !== sharedCount) {
    prevSharedCount = sharedCount;
    writeLocalSharedImportMap_temp(generateLocalSharedImportMap());
  }
}
```

This is called from the Alias Set 1 `customResolver` in `proxySharedModule()` every time a shared import is hit.

## The `localSharedImportMap` and how it feeds into `remoteEntry.js`

The `localSharedImportMap` is the bridge between "what shared deps does this app use?" (discovered during the build) and "what does this app contribute to the shared pool?" (declared in remoteEntry.js at runtime).

```
Build time                                       Runtime
────────────────────────────────                 ────────────────────────────────
Alias resolver encounters                        remoteEntry.init() is called
import of 'react'                                by a host or by itself
        │                                                │
        ▼                                                ▼
addUsedShares('react')                           runtime reads usedShared:
        │                                        "host has react@18.2.0"
        ▼                                                │
writeLocalSharedImportMap()                              ▼
generates importMap + usedShared                 runtime.loadShare('react')
        │                                        picks best version from all
        ▼                                        registered providers
localSharedImportMap is imported                         │
by remoteEntry.js                                        ▼
        │                                        returns factory → module
        ▼
remoteEntry embeds usedShared
in its init() / shared scope
```

The generated `localSharedImportMap` (produced by `generateLocalSharedImportMap()` in `src/virtualModules/virtualRemoteEntry.ts`) contains two objects:

### `importMap` — async factory functions

Each entry is an async function that imports the `__prebuild__` version of the package:

```js
const importMap = {
  react: async () => {
    let pkg = await import('__mf__virtual/host__prebuild__react__prebuild__');
    return pkg;
  },
  'react-dom': async () => {
    let pkg = await import('__mf__virtual/host__prebuild__react-dom__prebuild__');
    return pkg;
  },
};
```

If a shared dep has `import: false` in its config (meaning "I don't provide this, the host must"), the factory throws instead:

```js
"react": async () => {
  throw new Error("Shared module 'react' must be provided by host");
}
```

### `usedShared` — version metadata for runtime negotiation

Each entry declares the version, scope, and share config, plus a `get()` function that uses the `importMap` to lazily load the local copy:

```js
const usedShared = {
  react: {
    name: 'react',
    version: '18.2.0',
    scope: ['default'],
    loaded: false,
    from: 'host',
    async get() {
      usedShared['react'].loaded = true;
      const { react: pkgDynamicImport } = importMap;
      const res = await pkgDynamicImport();
      const exportModule = { ...res };
      Object.defineProperty(exportModule, '__esModule', {
        value: true,
        enumerable: false,
      });
      return function () {
        return exportModule;
      };
    },
    shareConfig: {
      singleton: false,
      requiredVersion: '^18.2.0',
    },
  },
};
```

Both `usedShared` and a `usedRemotes` array are exported from this file and imported by the generated `remoteEntry.js` (see `generateRemoteEntry()` in `src/virtualModules/virtualRemoteEntry.ts`):

```js
// Inside generated remoteEntry.js
import { usedShared, usedRemotes } from '<localSharedImportMapPath>';

async function init(shared = {}, initScope = []) {
  const initRes = runtimeInit({
    name: 'host',
    remotes: usedRemotes,
    shared: usedShared, // ← this is what other apps see
    // ...
  });
  // ...
}
```

## Dev vs Build: where the behavior diverges

The shared dependency system has the widest gap between dev and build behavior of any part of the plugin.

```
                    Build mode                          Dev mode
                    ──────────                          ────────
Module format       ESM (import/export)                 CJS (require/module.exports)
Top-level await     Native await keyword                Placeholder comment, later transformed
__prebuild__        Alias returns package name          Alias uses PromiseStore + customResolver
  resolution        (simple string replacement)         (async, caches resolved IDs)
localSharedImportMap  Generated after parsePromise      Generated immediately (parsePromise
  timing              resolves (all modules parsed)       resolves instantly in dev)
```

### Why CJS in dev mode?

The `__loadShare__` module needs to await the init promise before it can return the shared module. In build mode this uses a real `await`. In dev mode it can't — but the reason isn't simply "esbuild doesn't support top-level await" (it does, since ~0.14.39).

The real constraint is how Vite's dependency optimizer handles these virtual modules. In `src/index.ts`, the `module-federation-vite` plugin pushes the `__mf__virtual` directory into both `optimizeDeps.include` and `optimizeDeps.needsInterop`. The `needsInterop` flag tells Vite these modules need CJS/ESM interop wrappers — and those wrappers are synchronous. A top-level `await` in a module that Vite wraps with synchronous interop logic creates a conflict: the wrapper expects to synchronously access exports, but TLA makes the module asynchronous.

Additionally, the virtual modules live in `node_modules/__mf__virtual/`, which means they go through Vite's pre-bundling pipeline automatically (Vite pre-bundles everything in `node_modules/`). Once inside that pipeline, plugin hooks like `resolveId` and `load` lose control over the modules — as noted in the comment at the top of `src/virtualModules/virtualShared_preBuild.ts`: "Even the resolveId hook cannot interfere with vite pre-build."

So the plugin works around this with a two-step pattern:

1. Writes CJS modules with a placeholder comment instead of `await`: `/*mf top-level-await placeholder replacement mf*/`
2. Uses `require()` and `module.exports` so the interop wrappers work correctly
3. After pre-bundling, `pluginDevProxyModuleTopLevelAwait` finds the placeholder during Vite's `transform` hook and rewrites the exports to properly await the promise

The format branching happens in `writeLoadShareModule()` in `src/virtualModules/virtualShared_preBuild.ts`:

```js
const isBuild = command === 'build';
const importLine = isBuild
  ? `import { initPromise } from "${virtualRuntimeInitStatus.getImportId()}"`
  : `const {initPromise} = require("${virtualRuntimeInitStatus.getImportId()}")`;
const awaitOrPlaceholder = isBuild ? 'await ' : '/*mf top-level-await placeholder replacement mf*/';
const exportLine = isBuild ? 'export default exportModule' : 'module.exports = exportModule';
```

### The PromiseStore in dev mode

In build mode, Alias Set 2 (`__prebuild__` → real package) is a simple string replacement — the `replacement` function calls `assertModuleFound()` to extract the package name and returns it, letting Rollup resolve it normally.

In dev mode, the `customResolver` branch is more complex because of Vite's pre-bundle cache. When Vite pre-bundles `react`, it puts the result in `.vite/deps/react.js`. The resolver needs to distinguish between:

- The **original** module path (what the `localSharedImportMap` should reference)
- The **pre-bundled** path in `.vite/deps/` (what Vite's dev server actually serves)

The `PromiseStore` (`src/utils/PromiseStore.ts`) handles this by caching the first non-cache-dir resolution:

```js
const savePrebuild = new PromiseStore<string>();

async customResolver(source, importer) {
  const pkgName = module.name;
  const result = await this.resolve(pkgName, importer).then(item => item.id);
  if (!result.includes(_config.cacheDir)) {
    savePrebuild.set(pkgName, Promise.resolve(result));  // cache original path
  }
  return await this.resolve(await savePrebuild.get(pkgName), importer);
}
```

`PromiseStore` is a deferred map — calling `.get()` before `.set()` returns a promise that resolves when `.set()` is eventually called. This handles the case where multiple modules import `react` concurrently during dev startup: the first resolution caches the path, subsequent resolutions await it.

## Runtime negotiation: what `loadShare()` actually does

This plugin generates the _inputs_ to the shared dependency negotiation. The actual negotiation logic lives in `@module-federation/runtime` — it's not part of this plugin.

The boundary is clear:

```
This plugin's responsibility              @module-federation/runtime's responsibility
──────────────────────────────           ──────────────────────────────────────────
Generate usedShared with:                 Receive usedShared from all apps
 - version numbers                        Compare versions against requiredVersion
 - shareConfig (singleton, etc.)          Enforce singleton constraints
 - get() functions for local copies       Pick the best provider for each package
Generate __loadShare__ proxies            loadShare() returns Promise<() => module>
 that call runtime.loadShare()            loadShare() calls the chosen provider's get()
```

The contract from the runtime side:

```js
runtime.loadShare('react', {
  customShareInfo: {
    shareConfig: {
      singleton: false,
      strictVersion: false,
      requiredVersion: '^18.2.0',
    },
  },
});
// Returns: Promise<() => reactModule>
```

The runtime checks all registered providers (every app that called `init()` with react in their `usedShared`), picks the best version that satisfies the requiredVersion constraint, and returns a factory function. If `singleton: true` and versions conflict, the runtime will warn or error depending on `strictVersion`.

## The ESM shims: making proxied modules work with named imports

The `__loadShare__` virtual modules only export a default:

```js
export default exportModule;
```

But user code frequently uses named imports:

```js
import { useState, useEffect } from 'react';
```

Rollup can't resolve `useState` from a default export. The `module-federation-esm-shims` plugin (the inline plugin in `src/index.ts`, build mode only) fixes this by adding Rollup's [syntheticNamedExports](https://rollupjs.org/plugin-development/#synthetic-named-exports) support.

It transforms the `__loadShare__` module's export from:

```js
export default exportModule;
```

To:

```js
export const __moduleExports = exportModule;
export default exportModule.__esModule ? exportModule.default : exportModule;
```

And returns `{ syntheticNamedExports: '__moduleExports' }` — telling Rollup "when someone asks for a named export like `useState`, look it up on the `__moduleExports` object."

```
Without ESM shims                         With ESM shims
─────────────────                         ──────────────
import { useState }                       import { useState }
from 'react'                              from 'react'
      │                                         │
      ▼                                         ▼
__loadShare__/react                       __loadShare__/react
export default reactModule                export default reactModule.default
                                          export const __moduleExports = reactModule
      │                                         │
      ▼                                         ▼
  ✗ Rollup error:                           ✓ Rollup looks up
  'useState' is not                         __moduleExports.useState
  exported                                  → found
```

### Why not use `'default'` as the syntheticNamedExports key?

Rollup supports using `'default'` as the syntheticNamedExports key, which would seem simpler. But this bypasses Rollup's default-export interop logic. Libraries like `@emotion/styled` export a CJS module where the real function lives on `.default`:

```js
// @emotion/styled CJS output
module.exports.default = styledFunction;
```

With proper interop, `import styled from '@emotion/styled'` receives `styledFunction`. With `syntheticNamedExports: 'default'`, it would receive the raw namespace object (which has a `.default` property but isn't the function itself). Using a separate `__moduleExports` key preserves both behaviors: named imports resolve from the namespace, and default imports go through Rollup's normal interop.

This is documented in the comment block above the `module-federation-esm-shims` plugin in `src/index.ts`.

# Architecture Overview

`@module-federation/vite` is a Vite plugin that enables [Module Federation](https://module-federation.io/) — a pattern where independently built and deployed applications share code at runtime. One app can expose components, and another app can consume them, without either needing to be rebuilt when the other changes.

This document explains how the plugin works internally.

## What the plugin actually does

At a high level, the plugin intercepts Vite's build pipeline to:

1. **Generate a `remoteEntry.js` file** — the runtime contract that other apps use to load your exposed modules
2. **Rewrite imports of shared dependencies** (like `react` or `vue`) so they go through a runtime negotiation layer instead of being bundled directly
3. **Rewrite imports of remote modules** (like `import('remoteApp/Button')`) so they load from the remote app's `remoteEntry.js` at runtime
4. **Auto-initialize** the federation runtime when the app starts

## Core concepts

### Host and Remote

An app can be a **host** (consumes modules from other apps), a **remote** (exposes modules for other apps), or **both**.

```
┌─────────────────────────┐         ┌─────────────────────────┐
│       Host App          │         │      Remote App         │
│                         │         │                         │
│  import('shop/Cart')  ──┼────────>│  exposes: { './Cart' }  │
│                         │  HTTP   │                         │
│  shared: ['react']    ──┼────────>│  shared: ['react']      │
│                         │         | (negotiated at runtime) │
└─────────────────────────┘         └─────────────────────────┘
```

- **Remotes** declare `exposes` — a map of module names to file paths
- **Hosts** declare `remotes` — a map of names to URLs where `remoteEntry.js` can be fetched
- **Both** declare `shared` — dependencies that should be deduplicated at runtime (e.g. only one copy of React)

### The remoteEntry.js contract

Every federated app produces a `remoteEntry.js` with two exports:

```js
export async function init(shared, initScope) {
  /* ... */
}
export async function get(moduleName) {
  /* ... */
}
```

- `init()` sets up the shared dependency scope — it tells the runtime "I have react@18.2.0, vue@3.4.0, etc."
- `get()` returns a factory for the requested exposed module — e.g. `get('./Cart')` returns `() => cartModule`

When a host loads a remote, it fetches the remote's `remoteEntry.js`, calls `init()` to negotiate shared deps, then calls `get()` to load specific modules.

## Plugin composition

The `federation()` function doesn't return a single Vite plugin — it returns **an array of ~27 Vite plugins** that compose together via Vite's plugin pipeline. Many of the logical groups below expand internally into multiple plugins (typically a `serve` variant + a `build` variant, or an `enforce: 'pre'` + `enforce: 'post'` pair). The diagram shows the logical grouping, which is more useful for understanding than listing all 27 individually.

```
federation(userConfig)
  │
  ├── createEarlyVirtualModulesPlugin   Pre-creates virtual module files in config hook
  │                                       (before Vite optimization) to prevent 504 errors
  ├── vite:module-federation-config     Sets up virtual module directory, initializes state
  ├── aliasToArrayPlugin                Ensures config.resolve.alias is an array (normalize)
  ├── checkAliasConflicts               Warns if user aliases conflict with shared modules
  ├── normalizeOptimizeDepsPlugin       Normalizes optimizeDeps config format
  ├── pluginDts (×2)                    TypeScript declaration generation/consumption
  ├── pluginAddEntry (×2 each)          Emits build chunks and injects scripts:
  │     remoteEntry                       remoteEntry.js
  │     hostInit                          host initialization script
  │     virtualExposes                    exposed modules map
  ├── pluginProxyRemoteEntry            Generates remoteEntry.js code (the actual content)
  ├── pluginProxyRemotes                Rewrites remote imports → runtime.loadRemote()
  ├── pluginModuleParseEnd (×3)         Waits for all modules to be parsed before finalizing
  ├── proxySharedModule (×2)            Rewrites shared imports → runtime.loadShare()
  ├── module-federation-esm-shims       Build: manualChunks, syntheticNamedExports, renderChunk
  ├── module-federation-dev-await       Dev: injects await for loadShare inits in optimized deps
  ├── pluginDevProxyModuleTopLevelAwait Top-level await handling for dev mode
  ├── module-federation-vite            Runtime alias setup, optimizeDeps config, ENV_TARGET
  ├── pluginManifest (×2)               Generates mf-manifest.json metadata
  └── pluginVarRemoteEntry (×2)         Optional legacy "var" format remoteEntry
```

## How imports get rewritten

The plugin's main job is intercepting imports and replacing them with runtime calls. It does this by registering Vite [resolve aliases](https://vite.dev/config/shared-options.html#resolve-alias) with custom resolvers.

### Shared dependencies

When your code does `import React from 'react'` and `react` is in your `shared` config:

```
Source code                    After plugin transformation
─────────────────────         ──────────────────────────────────
import React from 'react'  →  import React from '__loadShare__/react'
```

The `__loadShare__/react` virtual module contains:

```js
import { initPromise } from '<runtimeInitStatus>';

const res = initPromise.then((runtime) =>
  runtime.loadShare('react', {
    customShareInfo: {
      /* version, singleton, etc */
    },
  })
);
const exportModule = await res.then((factory) => factory());
export default exportModule;
```

This means: wait for federation to initialize, ask the runtime for the best available version of `react` (which might come from the host, a remote, or your own bundle), and re-export it.

### Remote modules

When your code does `import('shop/Cart')` and `shop` is in your `remotes` config:

```
Source code                        After plugin transformation
─────────────────────────         ──────────────────────────────────
import('shop/Cart')            →  import('__loadRemote__/shop/Cart')
```

The `__loadRemote__/shop/Cart` virtual module contains:

```js
import { initPromise } from '<runtimeInitStatus>';

const res = initPromise.then((runtime) => runtime.loadRemote('shop/Cart'));
const exportModule = await initPromise.then((_) => res);
export default exportModule;
```

This means: wait for initialization, then ask the runtime to fetch and return the module from the remote app.

## Virtual modules

The plugin generates code at build time — things like the remoteEntry content, the shared module proxies, and the remote module loaders. These are called "virtual modules."

**Key detail:** Vite's pre-bundling (dependency optimization) doesn't work well with truly virtual modules (ones that only exist in memory via `resolveId`/`load` hooks). So instead, this plugin writes physical files to disk at `node_modules/__mf__virtual/`. The `VirtualModule` utility class manages this.

```
node_modules/
  __mf__virtual/
    ├── host__loadShare__react__loadShare__.js     Shared module proxy for react
    ├── host__loadShare__vue__loadShare__.js        Shared module proxy for vue
    ├── host__prebuild__react__prebuild__.js        Pre-built react (placeholder)
    ├── host__loadRemote__shop_Cart__loadRemote__.js  Remote module loader
    ├── hostAutoInit__H_A_I__.js                   Host auto-init script
    ├── localSharedImportMap_temp.js               Shared module metadata
    └── ...
```

Each virtual module file is written by a `VirtualModule` instance. The naming convention is:

```
{appName}{tag}{moduleName}{tag}.{suffix}
```

Where `tag` identifies the type: `__loadShare__`, `__prebuild__`, `__loadRemote__`, `__H_A_I__` (host auto init).

## Build vs Dev mode

### Build mode

During build, the plugin uses Vite/Rollup's standard chunk emission. The sequence is:

```
1. Config phase
   └── Register aliases for shared deps and remotes
   └── Write initial virtual module files to disk

2. Build starts
   └── pluginAddEntry emits chunks: remoteEntry, hostInit, virtualExposes
   └── Vite resolves imports, hitting the aliases registered in step 1
   └── Each alias hit writes/updates its virtual module file

3. Module parsing
   └── pluginModuleParseEnd tracks all modules being parsed
   └── Waits until parsing completes (or timeout — default 10s)
   └── This ensures we know ALL shared deps and remotes actually used

4. Code generation
   └── pluginProxyRemoteEntry generates final remoteEntry.js code
       (includes only actually-used shared deps and remotes)
   └── ESM shims plugin:
       - manualChunks forces loadShare modules into separate chunks
       - syntheticNamedExports enables named imports from proxied modules
       - renderChunk injects missing `await` calls for loadShare inits

5. Bundle output
   └── pluginMFManifest analyzes chunks → emits mf-manifest.json
   └── pluginVarRemoteEntry optionally generates legacy format
   └── pluginAddEntry injects <script> tags into HTML if needed
```

The "wait for module parsing" step (3) is important: the remoteEntry needs to declare which shared dependencies and remotes are actually used. But that's only known after Vite has resolved all imports. So `pluginProxyRemoteEntry` awaits `parsePromise` before generating its output.

### Dev mode (serve)

Dev mode works differently because there's no Rollup chunking — Vite serves modules on-demand over HTTP. This changes how every piece of the plugin operates.

```
1. Config phase (early init plugin)
   └── createEarlyVirtualModulesPlugin runs in config hook (enforce: 'pre')
   └── Creates __mf__virtual/ directory structure via initVirtualModuleInfrastructure()
   └── Sets VirtualModule root, creates core virtual modules
   └── Pre-creates all shared module files (__loadShare__ + __prebuild__)
       so they exist BEFORE Vite's dependency optimizer runs
   └── parsePromise resolves immediately (no module-parse tracking in dev)

1b. Config phase (other plugins)
   └── Register aliases for shared deps and remotes
   └── proxyPreBuildShared.configResolved re-creates files as redundancy

2. Server starts
   └── Optimizer discovers pre-created virtual modules (no late-discovery 504s)
   └── pluginAddEntry registers middleware:
       requests to /remoteEntry.js → redirected to the virtual module path
   └── pluginAddEntry injects hostInit via transformIndexHtml:
       <script type="module" src="/@id/hostAutoInit..."> into <head>

3. Browser loads page
   └── hostInit script runs, dynamically imports remoteEntry from dev server
   └── remoteEntry.init() called — same as build mode
   └── initPromise resolves

4. Module requests arrive
   └── Browser requests shared dep (e.g. react)
   └── Alias resolver intercepts → returns __loadShare__ virtual module path
   └── Vite serves the virtual module file from node_modules/__mf__virtual/
   └── Same flow for remote modules via __loadRemote__

5. Top-level await transformation
   └── pluginDevProxyModuleTopLevelAwait runs on each served module
   └── Finds the placeholder comment: /*mf top-level-await placeholder replacement mf*/
   └── Rewrites exports to await the result (see below)
```

#### The CJS + placeholder pattern (Vite 5-7)

In build mode and Rolldown environments (Vite 8+), virtual modules for shared/remote deps use `import` and `await`:

```js
import { initPromise } from '<runtimeInitStatus>';
const exportModule = await initPromise.then(/* ... */);
export default exportModule;
```

In dev mode on Vite 5-7 (non-Rolldown), the same modules use `require()` and a placeholder comment instead:

```js
const { initPromise } = require('<runtimeInitStatus>');
const exportModule = /*mf top-level-await placeholder replacement mf*/ initPromise.then(/* ... */);
module.exports = exportModule;
```

Why? Vite's dev server pre-bundles dependencies with esbuild, which doesn't support top-level `await`. The placeholder comment is a marker — `pluginDevProxyModuleTopLevelAwait` finds it during the `transform` hook and rewrites the exports to properly await the promise:

```js
// Before transform:
export default exportModule;

// After transform:
const __mfproxy__awaitdefault = await exportModule();
const __mfproxy__default = __mfproxy__awaitdefault;
export { __mfproxy__default as default };
```

This two-step approach (CJS generation → ESM rewrite) works around the pre-bundling limitation while keeping the module semantics correct for the browser.

#### Rolldown (Vite 8+) — ESM in dev mode

When Rolldown is detected (`this.meta.rolldownVersion` exists), the plugin uses ESM with real `await` in dev mode too — the same format as build mode. Rolldown supports top-level await natively, eliminating the need for the CJS + placeholder workaround. The format selection is controlled by `useESM = command === 'build' || isRolldown` in `writeLoadShareModule()`.

## Initialization sequence at runtime

When the app loads in the browser, this happens:

```
1. Browser loads index.html
2. hostInit script runs (injected by pluginAddEntry)
3. hostInit imports remoteEntry.js
4. remoteEntry.init() is called:
   a. Calls @module-federation/runtime init()
   b. Registers shared modules (with version, singleton config)
   c. Registers remote entries (URLs of other apps)
   d. Initializes shared scope (negotiates versions with any already-loaded remotes)
   e. Resolves initPromise — all __loadShare__ and __loadRemote__ modules can now proceed
5. App code runs, import('remote/Module') resolves through loadRemote()
6. Shared deps resolve through loadShare() — runtime picks the best available version
```

The `initPromise` is the synchronization point. All proxied imports (both shared and remote) await this promise before calling into the runtime. This guarantees the federation runtime is ready before any federated module is loaded.

This sequence is the same whether the app is a host, a remote, or both. The distinction between host and remote is purely about config — `exposes` vs `remotes` — not about the initialization codepath. An app that is both a host and a remote runs this sequence once, and its `remoteEntry.init()` both registers its own shared deps and sets up its remote connections.

## What can go wrong

### TLA deadlock with Rolldown (Vite 8+)

Rolldown compiles top-level await into `__tla` Promise exports rather than preserving browser-level TLA. This creates several deadlock scenarios:

1. **Fire-and-forget hostInit** — An external `<script src="hostInit.js">` evaluates immediately without awaiting TLA, so `initPromise` may not resolve before `loadShare` chunks evaluate. Fix: hostInit is injected as an inline `<script type="module">await import("hostInit.js").then(m => m.__tla)</script>`.

2. **Circular side-effect imports** — Rolldown adds bare `import"./loadShare_chunk.js"` to shared bundles, creating circular TLA dependencies. Fix: the `generateBundle` hook strips these side-effect imports from non-loadShare chunks.

3. **Lazy-init wrappers** — Rolldown wraps loadShare modules with `var X = n(async () => {...})`, leaving exports undefined until `X()` is called. Fix: the `generateBundle` hook adds `await X();` before the export statement in loadShare chunks.

These fixes are applied as post-processing in the `module-federation-esm-shims` plugin's `generateBundle` hook. The helper functions `removeSideEffectLoadShareImports()` and `eagerEvaluateLazyInit()` in `src/utils/bundleHelpers.ts` implement fixes 2 and 3 respectively.

### Module parse timeout (build only)

During build, the plugin waits for all modules to be parsed before generating `remoteEntry.js` (so it knows which shared deps are actually used). If parsing takes longer than the timeout (default: 10 seconds, configurable via `moduleParseTimeout`), the plugin logs a warning and force-resolves:

```
Parse timeout (10s) - forcing resolve
```

This is a **soft failure** — the build continues, but the remoteEntry may be generated before all modules have been parsed. This can mean some shared dependencies are missing from the remoteEntry's metadata. If you see this warning, increase `moduleParseTimeout` or investigate why module parsing is slow (large dependency trees, slow plugins).

### Remote unreachable at runtime

If a remote's `remoteEntry.js` can't be fetched (network error, wrong URL, remote is down), the failure happens at runtime in the browser, not at build time. The `runtime.loadRemote()` call will reject, which surfaces as a failed dynamic `import()`. This is handled by `@module-federation/runtime`, not by this plugin — the plugin's job ends at build time.

### Shared dependency version mismatch

Version negotiation (singleton conflicts, incompatible `requiredVersion` constraints) is handled entirely by `@module-federation/runtime` at initialization time. This plugin's role is to declare what versions are available — it generates the `usedShared` metadata with version numbers and `shareConfig` (singleton, requiredVersion). The runtime decides what to do with that information. Check the [`@module-federation/runtime` docs](https://module-federation.io/) for the negotiation logic.

## Key source files

| File                                              | Purpose                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| `src/index.ts`                                    | Plugin composition — assembles and returns the plugin array          |
| `src/utils/normalizeModuleFederationOptions.ts`   | Normalizes user config (resolves versions, parses remote URLs, etc.) |
| `src/utils/VirtualModule.ts`                      | Writes physical files to `node_modules/__mf__virtual/`               |
| `src/plugins/pluginAddEntry.ts`                   | Emits build chunks and injects scripts into HTML                     |
| `src/plugins/pluginProxyRemoteEntry.ts`           | Generates the remoteEntry.js code                                    |
| `src/plugins/pluginProxyRemotes.ts`               | Alias rewriting for remote module imports                            |
| `src/plugins/pluginProxySharedModule_preBuild.ts` | Alias rewriting for shared dependency imports                        |
| `src/plugins/pluginModuleParseEnd.ts`             | Tracks module parsing, exposes `parsePromise`                        |
| `src/plugins/pluginMFManifest.ts`                 | `pluginManifest()` — generates mf-manifest.json with asset metadata  |
| `src/virtualModules/virtualRemoteEntry.ts`        | Code generation for remoteEntry and host auto-init                   |
| `src/virtualModules/virtualRemotes.ts`            | Code generation for `__loadRemote__` modules                         |
| `src/virtualModules/virtualShared_preBuild.ts`    | Code generation for `__loadShare__` and `__prebuild__` modules       |
| `src/virtualModules/virtualExposes.ts`            | Code generation for the exposed modules map                          |
| `src/utils/bundleHelpers.ts`                      | Post-processing helpers for Rolldown TLA fixes                       |
| `src/virtualModules/virtualRuntimeInitStatus.ts`  | The `initPromise` / `initResolve` synchronization module             |

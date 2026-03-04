# Entry Injection — Deep Dive

## Contents

- [What entry injection does](#what-entry-injection-does)
- [The three `addEntry` invocations](#the-three-addentry-invocations)
- [How `addEntry` works internally](#how-addentry-works-internally)
  - [The two plugins it returns](#the-two-plugins-it-returns)
  - [Injection mode: `'html'` vs `'entry'`](#injection-mode-html-vs-entry)
- [Build mode: chunk emission and HTML injection](#build-mode-chunk-emission-and-html-injection)
  - [Step 1: Emit chunks (`buildStart`)](#step-1-emit-chunks-buildstart)
  - [Step 2: Inject into entry files (`transform`)](#step-2-inject-into-entry-files-transform)
  - [Step 3: Inject into HTML (`generateBundle`)](#step-3-inject-into-html-generatebundle)
  - [The `renderBuiltUrl` integration](#the-renderbuilturl-integration)
- [Dev mode: middleware and HTML transformation](#dev-mode-middleware-and-html-transformation)
  - [URL rewriting middleware](#url-rewriting-middleware)
  - [HTML script injection](#html-script-injection)
  - [Edge case: SvelteKit compatibility](#edge-case-sveltekit-compatibility)
  - [Vite 8 / Rolldown note](#vite-8--rolldown-note)
- [Putting it all together: what ends up in the browser](#putting-it-all-together-what-ends-up-in-the-browser)

## What entry injection does

The other parts of the plugin _generate_ code — remoteEntry content, shared dep proxies, remote loaders. But that code needs to actually get into the build output and the browser. That's `pluginAddEntry`'s job.

It solves three problems:

1. **Emit `remoteEntry.js` as a build artifact** — so other apps can fetch it
2. **Run `hostInit` early in the page lifecycle** — so federation is initialized before any app code tries to load shared deps or remote modules
3. **Include `virtualExposes` in the bundle** — so the exposed modules map is available to the remoteEntry

```
pluginAddEntry is called 3 times
         │
         ├── remoteEntry ──── emits remoteEntry.js as a named chunk
         │                     (other apps fetch this file)
         │
         ├── hostInit ─────── injects initialization script into the page
         │                     (runs before app code, calls remoteEntry.init())
         │
         └── virtualExposes ── includes the exposed modules map in the bundle
                                (referenced by remoteEntry's get() function)
```

## The three `addEntry` invocations

In `src/index.ts`, `addEntry` is called three times with different options:

```js
// 1. remoteEntry — the file other apps fetch
const remoteEntryId = getRemoteEntryId(options); // e.g. 'virtual:mf-REMOTE_ENTRY_ID:shop__remoteEntry_js'
...addEntry({
  entryName: 'remoteEntry',
  entryPath: remoteEntryId,
  fileName: filename,                   // e.g. 'remoteEntry-[hash]'
})

// 2. hostInit — the initialization script
...addEntry({
  entryName: 'hostInit',
  entryPath: getHostAutoInitPath(),     // physical file in __mf__virtual/
  inject: hostInitInjectLocation,       // 'html' (default) or 'entry'
})

// 3. virtualExposes — the exposed modules map
const virtualExposesId = getVirtualExposesId(options); // e.g. 'virtual:mf-exposes:shop__remoteEntry_js'
...addEntry({
  entryName: 'virtualExposes',
  entryPath: virtualExposesId,
})
```

Each call spreads two plugins into the array (a serve plugin and a build plugin), so these three invocations contribute 6 plugins total.

The key differences between the three:

| Invocation     | `fileName`             | `inject`              | Purpose                                            |
| -------------- | ---------------------- | --------------------- | -------------------------------------------------- |
| remoteEntry    | `'remoteEntry-[hash]'` | `'entry'` (default)   | Emit as a named chunk with a specific filename     |
| hostInit       | `undefined`            | `'html'` or `'entry'` | Inject into page so it runs before app code        |
| virtualExposes | `undefined`            | `'entry'` (default)   | Include in the bundle graph (no special injection) |

The `fileName` and `inject` options completely change how `addEntry` behaves. `fileName` controls whether the chunk gets a specific output name (and whether the dev middleware creates a redirect). `inject` controls whether the script gets wired into HTML or into JS entry files.

## How `addEntry` works internally

### The two plugins it returns

Each `addEntry()` call returns an array of two plugins (`src/plugins/pluginAddEntry.ts`). Both plugins are named `'add-entry'` — this is unusual (most Vite plugins have unique names) and can be confusing when debugging the plugin pipeline, but it works because Vite doesn't require unique names.

```
addEntry({ entryName, entryPath, fileName, inject })
  │
  ├── Plugin 1: 'add-entry' (apply: 'serve')
  │     ├── configResolved()     Prepend config.base to devEntryPath, normalize separators
  │     ├── configureServer()    Middleware: redirect fileName requests
  │     ├── transformIndexHtml() Inject <script> into HTML (if inject='html')
  │     └── transform()          SvelteKit compatibility fallback
  │
  └── Plugin 2: 'add-entry' (enforce: 'post')
        ├── configResolved()     Detect entry files and HTML files
        ├── buildStart()         Emit the chunk via Rollup
        ├── transform()          Prepend import into entry files (if inject='entry')
        └── generateBundle()     Inject <script> into HTML output (if inject='html')
```

### Injection mode: `'html'` vs `'entry'`

The `inject` option determines how the script gets wired into the page. Two helper functions control the branching:

```js
function injectHtml() {
  return inject === 'html' && htmlFilePath;
}

function injectEntry() {
  return inject === 'entry' || !htmlFilePath;
}
```

These are complementary — exactly one is true for any given state:

| `inject`  | `htmlFilePath` | `injectHtml()` | `injectEntry()` | What happens                               |
| --------- | -------------- | -------------- | --------------- | ------------------------------------------ |
| `'html'`  | exists         | `true`         | `false`         | `<script>` tag inserted into HTML `<head>` |
| `'html'`  | missing        | `false`        | `true`          | Falls back to entry-file import injection  |
| `'entry'` | any            | `false`        | `true`          | `import` prepended to JS entry files       |

- **`'html'` mode**: Inserts a `<script type="module">` tag into the `<head>` of the HTML file. Used for `hostInit` by default — this ensures the init script runs as early as possible, before any bundled JS.
- **`'entry'` mode**: Prepends an `import` statement to the top of JS entry files. Used for `remoteEntry` and `virtualExposes` — these need to be in the bundle graph but don't need to run before other code.

The fallback (row 2) matters for library builds or SSR setups where there's no `index.html`. In that case, even `inject: 'html'` falls back to entry-file injection.

### How `htmlFilePath` gets resolved

`htmlFilePath` is the lynchpin — it controls which injection path is taken. It's resolved in the build plugin's `configResolved` hook by inspecting Rollup's input options:

```js
configResolved(config) {
  const inputOptions = config.build.rollupOptions.input;

  if (!inputOptions) {
    // No explicit input — assume standard index.html at project root
    htmlFilePath = path.resolve(config.root, 'index.html');
  } else if (typeof inputOptions === 'string') {
    entryFiles = [inputOptions];
  } else if (Array.isArray(inputOptions)) {
    entryFiles = inputOptions;
  } else if (typeof inputOptions === 'object') {
    entryFiles = Object.values(inputOptions);
  }

  if (entryFiles.length > 0) {
    htmlFilePath = getFirstHtmlEntryFile(entryFiles);  // first .html file, if any
  }
}
```

The logic handles all the ways Vite/Rollup accepts inputs:

- **No input** (default): assumes `index.html` at the project root — the standard Vite SPA setup
- **String**: single entry file (e.g. `'src/main.ts'`)
- **Array**: multiple entry files
- **Object**: named entries (e.g. `{ main: 'src/main.ts', admin: 'src/admin.ts' }`)

If any of the entry files is an HTML file, it becomes `htmlFilePath`. If none are HTML, `htmlFilePath` stays `undefined` and `injectHtml()` returns `false` regardless of the `inject` option.

### How `devEntryPath` gets resolved

The serve plugin's `configResolved` hook prepends `config.base` to `devEntryPath` and normalizes path separators:

```js
configResolved(config) {
  devEntryPath = config.base + devEntryPath
    .replace(/\\\\?/g, '/')           // normalize backslashes
    .replace(/.+?\:([/\\])[/\\]?/, '$1')  // strip drive letter (Windows)
    .replace(/^\//, '');               // remove leading slash (base already has one)
}
```

This is important because `devEntryPath` is used in three places: the middleware URL matching, the `transformIndexHtml` script tag, and the SvelteKit fallback. All three need paths that include `config.base` — without this normalization, apps with non-root base paths (e.g. `base: '/my-app/'`) would produce broken URLs.

## Build mode: chunk emission and HTML injection

### Step 1: Emit chunks (`buildStart`)

During Rollup's `buildStart` hook, each `addEntry` instance emits a chunk:

```js
buildStart() {
  const emitFileOptions = {
    name: entryName,       // 'remoteEntry', 'hostInit', or 'virtualExposes'
    type: 'chunk',
    id: entryPath,         // the virtual module ID or physical file path
    preserveSignature: 'strict',
  };
  if (!hasHash) {
    emitFileOptions.fileName = fileName;  // exact output filename
  }
  emitFileId = this.emitFile(emitFileOptions);
}
```

For remoteEntry, this is what causes Rollup to include the virtual `remoteEntry.js` in the build output. The `fileName` option gives it a predictable name (like `remoteEntry-abc123.js`) so other apps can reference it at a known URL.

For `hostInit` and `virtualExposes`, no `fileName` is set, so Rollup assigns hashed filenames automatically. These aren't fetched by other apps — they just need to be in the bundle.

The `buildStart` hook also scans the HTML file for existing `<script>` tags and adds their `src` paths to `entryFiles`. This is how the plugin knows which JS files are entry points — needed for `inject: 'entry'` mode.

### Step 2: Inject into entry files (`transform`)

For `inject: 'entry'` mode, the build plugin's `transform` hook prepends an import to each entry file:

```js
transform(code, id) {
  if (injectEntry() && entryFiles.some(file => id.endsWith(file))) {
    const injection = `import ${JSON.stringify(entryPath)};`;
    return mapCodeToCodeWithSourcemap(injection + code);
  }
}
```

The import is prepended to the source and wrapped with `mapCodeToCodeWithSourcemap()` to preserve sourcemap correctness — without this, the injected import would shift all line numbers in the original file, breaking debugger breakpoints and error stack traces.

This is how `remoteEntry` and `virtualExposes` get pulled into the bundle graph. Rollup sees the import, follows it to the virtual module, and includes its code in the output.

For `hostInit` with `inject: 'entry'`, the same thing happens — the init script gets imported at the top of your app's entry file, ensuring it runs before any app code.

### Step 3: Inject into HTML (`generateBundle`)

For `inject: 'html'` mode, the build plugin's `generateBundle` hook inserts a `<script>` tag into every HTML file in the bundle:

```js
generateBundle(options, bundle) {
  if (!injectHtml()) return;
  const file = this.getFileName(emitFileId);  // actual output filename

  for (const fileName in bundle) {
    if (fileName.endsWith('.html')) {
      let htmlAsset = bundle[fileName];
      if (htmlAsset.type === 'chunk') return;  // skip non-asset HTML entries

      const path = resolvePath(fileName);
      let htmlContent = htmlAsset.source.toString();
      htmlContent = htmlContent.replace(
        '<head>',
        `<head><script type="module" src="${path}"></script>`
      );
      htmlAsset.source = htmlContent;
    }
  }
}
```

The `type === 'chunk'` guard prevents processing non-asset HTML entries — Rollup's bundle can contain both asset and chunk entries with `.html` extensions, and only assets have a `.source` property to modify. The script tag is inserted at the start of `<head>` — before any other scripts — so it runs as early as possible. This is the default behavior for `hostInit`.

### The `renderBuiltUrl` integration

The `generateBundle` hook also supports Vite's experimental `renderBuiltUrl` API. If the user has configured custom URL resolution (common in advanced deployment setups), the plugin delegates to it:

```js
const resolvePath = (htmlFileName) => {
  if (!viteConfig.experimental?.renderBuiltUrl) {
    return viteConfig.base + file; // default: base + filename
  }

  const result = viteConfig.experimental.renderBuiltUrl(file, {
    hostId: htmlFileName,
    hostType: 'html',
    type: 'asset',
    ssr: false,
  });

  if (typeof result === 'string') return result;
  if (result?.relative) return file;
  // Runtime code can't be used in <script src=""> — fall back
  return viteConfig.base + file;
};
```

This ensures the injected script tags work correctly even when assets are deployed to CDNs or served from non-standard paths.

## Dev mode: middleware and HTML transformation

In dev mode, there's no Rollup build — Vite serves modules on demand. The serve plugin handles this with middleware and HTML transforms.

### URL rewriting middleware

The serve plugin registers middleware that redirects requests for the `fileName` to the virtual module path:

```js
configureServer(server) {
  server.middlewares.use((req, res, next) => {
    if (!fileName) { next(); return; }
    if (req.url.startsWith((viteConfig.base + fileName).replace(/^\/?/, '/'))) {
      req.url = devEntryPath;  // e.g. '/@id/virtual:mf-REMOTE_ENTRY_ID:shop__remoteEntry_js'
    }
    next();
  });
}
```

The URL check accounts for `config.base` — this matters for production deployments with non-root base paths (e.g. `base: '/my-app/'`), where the request URL would be `/my-app/remoteEntry-[hash]` rather than `/remoteEntry-[hash]`.

This only applies to the `remoteEntry` invocation (which has a `fileName`). When another app requests the remoteEntry URL from the dev server, the middleware redirects it to Vite's virtual module resolution path. Vite then serves the generated remoteEntry code through its normal plugin pipeline (`pluginProxyRemoteEntry` handles the actual code generation).

For `hostInit` and `virtualExposes`, `fileName` is `undefined`, so the middleware does nothing — these don't need to be externally addressable.

### HTML script injection

For `inject: 'html'` mode, the serve plugin uses Vite's `transformIndexHtml` hook:

```js
transformIndexHtml(html) {
  if (!injectHtml()) return;
  return html.replace(
    '<head>',
    `<head><script type="module" src=${JSON.stringify(devEntryPath)}></script>`
  );
}
```

The `src` attribute is wrapped in `JSON.stringify()` rather than bare template-literal quotes. This properly escapes any special characters in the path, preventing XSS if the path ever contained unexpected content.

In dev mode, `devEntryPath` points to the physical file in `node_modules/__mf__virtual/` (prefixed with `config.base`), so Vite serves it directly.

### Edge case: SvelteKit compatibility

SvelteKit doesn't have a standard `index.html` — it generates HTML server-side. The serve plugin has a workaround in its `transform` hook to handle this:

```js
transform(code, id) {
  if (id.includes('node_modules') || inject !== 'html' || htmlFilePath) return;

  if (id.includes('.svelte-kit') && id.includes('internal.js')) {
    return code.replace(
      /<head>/g,
      '<head><script type="module" src="' + src + '"></script>'
    );
  }
}
```

This detects SvelteKit's internal template file and injects the script tag there. The conditions are specific:

- Only runs for `inject: 'html'` mode
- Only runs when no `htmlFilePath` was detected (no standard index.html)
- Only matches SvelteKit's `.svelte-kit/*/internal.js` file

### Vite 8 / Rolldown note

Entry injection mechanics are unchanged in Rolldown/Vite 8+: `pluginAddEntry` still does the same two things in dev (`configureServer` URL rewrite for named entries and `transformIndexHtml` script injection for `inject: 'html'`) and the same `buildStart`/`transform`/`generateBundle` flow in build mode.

The Vite 8+ changes in this plugin live elsewhere (virtual module format and shared/remote proxy behavior), not in how entries are emitted/injected.

## Putting it all together: what ends up in the browser

Here's the complete picture for each invocation, in both modes:

### Build output

```
┌─ remoteEntry (fileName: 'remoteEntry-[hash]', inject: 'entry') ──────────────┐
│                                                                               │
│  Build: Emits remoteEntry-abc123.js as a named chunk                          │
│         Import prepended to entry files → pulled into bundle graph            │
│                                                                               │
│  Result: Standalone JS file fetchable by other apps at a known URL            │
└───────────────────────────────────────────────────────────────────────────────┘

┌─ hostInit (fileName: none, inject: 'html') ──────────────────────────────────┐
│                                                                               │
│  Build: Emits hostInit-xyz789.js as an anonymous chunk                        │
│         <script type="module" src="/hostInit-xyz789.js"> injected into <head> │
│                                                                               │
│  Result: Runs before any app code, imports remoteEntry, calls init()          │
│                                                                               │
│  Generated hostInit file contents:                                            │
│    const remoteEntryPromise = import("virtual:mf-REMOTE_ENTRY_ID:<scope>")    │
│    Promise.resolve(remoteEntryPromise)                                        │
│      .then(remoteEntry => {                                                   │
│        return Promise.resolve(remoteEntry.__tla)                              │
│          .then(remoteEntry.init).catch(remoteEntry.init)                      │
│      })                                                                       │
└───────────────────────────────────────────────────────────────────────────────┘

┌─ virtualExposes (fileName: none, inject: 'entry') ───────────────────────────┐
│                                                                               │
│  Build: Emits virtualExposes chunk (hashed name)                              │
│         Import prepended to entry files → pulled into bundle graph            │
│                                                                               │
│  Result: The exposesMap is available for remoteEntry's get() function          │
└───────────────────────────────────────────────────────────────────────────────┘
```

### Dev server

```
┌─ remoteEntry (fileName: 'remoteEntry-[hash]') ──────────────────────────────┐
│                                                                              │
│  Dev: Middleware redirects /remoteEntry-[hash] → /@id/virtual:mf-...         │
│       pluginProxyRemoteEntry generates code on the fly                       │
│                                                                              │
│  Result: Other apps can fetch remoteEntry from the dev server URL            │
└──────────────────────────────────────────────────────────────────────────────┘

┌─ hostInit (inject: 'html') ──────────────────────────────────────────────────┐
│                                                                              │
│  Dev: transformIndexHtml injects <script> pointing to __mf__virtual/ file    │
│       pluginProxyRemoteEntry generates dev-specific init code (dynamic       │
│       import from window.origin + remoteEntry filename)                      │
│                                                                              │
│  Result: Browser loads hostInit, which fetches remoteEntry from dev server   │
└──────────────────────────────────────────────────────────────────────────────┘

┌─ virtualExposes ─────────────────────────────────────────────────────────────┐
│                                                                              │
│  Dev: No special handling needed — Vite resolves the virtual module          │
│       through pluginProxyRemoteEntry's resolveId/load hooks                  │
│                                                                              │
│  Result: Available when remoteEntry's get() function is called               │
└──────────────────────────────────────────────────────────────────────────────┘
```

### The injection timeline in the browser

```
1. Browser requests index.html
2. HTML contains <script type="module" src="hostInit-xyz789.js"> in <head>
3. Browser fetches and executes hostInit
4. hostInit imports remoteEntry.js (build) or fetches it from dev server (dev)
5. remoteEntry.init() runs:
   ├── Registers shared deps and remotes with the runtime
   ├── Negotiates shared dep versions
   └── Resolves initPromise
6. App's entry JS file loads (may have import of remoteEntry/virtualExposes prepended)
7. Any import('remote/Module') or import of a shared dep resolves through the
   now-initialized runtime
```

The key ordering guarantee: because `hostInit` is injected into `<head>` as a separate `<script>` tag (in `'html'` mode), it starts loading before the app's bundled JS. By the time the app code runs and hits a `__loadShare__` or `__loadRemote__` import, `initPromise` has already resolved (or is about to). This is why `'html'` is the default for `hostInitInjectLocation` — it provides the earliest possible initialization.

With `inject: 'entry'`, the init import is at the top of the entry file, so it runs first within that file's execution, but the file itself may load later than a dedicated `<script>` tag would.

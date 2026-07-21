# Migrating from `@originjs/vite-plugin-federation`

This guide migrates hosts and remotes that use Vite as their build tool from `@originjs/vite-plugin-federation` (OriginJS) to `@module-federation/vite`.

## What changes

Both plugins expose modules through `remoteEntry` files, but their host-remote configuration models differ.

- OriginJS treats a remote declared as a URL string, or an object without `format`, as an `esm` remote by default.
- `@module-federation/vite` uses the Module Federation runtime. Its string remote shorthand is a **`var` remote**; Vite ESM remotes must be declared with `type: 'module'`.
- Migrate uses of OriginJS's `virtual:__federation__` module to the Module Federation runtime API.
- `@module-federation/vite` can consume Vite module remotes as well as `var` remotes from Vite, Webpack, and Rspack. It also supports manifests.

Keep the host remote alias and expose keys stable during the first migration. That keeps existing imports such as `import('catalog/Product')` unchanged.

## Requirements

Before replacing the plugin, verify that each application being migrated uses a version supported by `@module-federation/vite`:

- Node.js `^20.19.0` or `>=22.12.0`
- Vite 5, 6, 7, or 8

Upgrade the application toolchain first if it uses an older Node.js or Vite version.

## Step 1: Replace the package

Install the Vite plugin in each host and remote that continues to use build-time federation, then remove OriginJS after its configuration is no longer used. A host managed entirely through the runtime does not need the Vite plugin; install the runtime package described in [Step 4](#step-4-migrate-dynamic-remotes) instead.

### pnpm

```sh
pnpm add @module-federation/vite
```

### npm

```sh
npm install @module-federation/vite
```

### Yarn

```sh
yarn add @module-federation/vite
```

Install dependencies in the application package that owns the federation configuration.

## Step 2: Migrate a Vite-built remote

Migrate one remote first and verify it with a single host before migrating the remaining applications.

### OriginJS remote

```ts
import federation from "@originjs/vite-plugin-federation";

export default {
  plugins: [
    federation({
      name: "catalog",
      filename: "remoteEntry.js",
      exposes: {
        "./Product": "./src/Product.tsx",
      },
      shared: ["react", "react-dom"],
    }),
  ],
};
```

### `@module-federation/vite` remote

```ts
import { defineConfig } from "vite";
import { federation } from "@module-federation/vite";

export default defineConfig({
  plugins: [
    federation({
      name: "catalog",
      filename: "remoteEntry.js",
      exposes: {
        "./Product": "./src/Product.tsx",
      },
      shared: ["react", "react-dom"],
    }),
  ],
});
```

`name` and expose keys remain unchanged, so existing consumer imports continue to work.

With Vite's default build settings, the same `filename` produces a different remote entry path:

- OriginJS with `filename: 'remoteEntry.js'`: `dist/assets/remoteEntry.js`
- `@module-federation/vite` with `filename: 'remoteEntry.js'`: `dist/remoteEntry.js`

To keep the existing `/assets/remoteEntry.js` URL, set `filename: 'assets/remoteEntry.js'`. Otherwise, update the host's `entry` URL to the new location.

If an OriginJS expose uses object form, carry over only its `import` value. The OriginJS `name` and `dontAppendStylesToHead` options have no direct equivalents and cannot be copied unchanged. If you use `dontAppendStylesToHead`, follow the CSS guidance in [Step 5](#step-5-review-shared-dependencies-and-css).

## Step 3: Migrate a Vite host

### OriginJS host

```ts
import federation from "@originjs/vite-plugin-federation";

export default {
  plugins: [
    federation({
      name: "storefront",
      remotes: {
        catalog: "https://cdn.example.com/catalog/remoteEntry.js",
      },
      shared: ["react", "react-dom"],
    }),
  ],
};
```

### `@module-federation/vite` host

```ts
import { defineConfig } from "vite";
import { federation } from "@module-federation/vite";

export default defineConfig({
  plugins: [
    federation({
      name: "storefront",
      remotes: {
        catalog: {
          name: "catalog",
          entry: "https://cdn.example.com/catalog/remoteEntry.js",
          type: "module",
        },
      },
      shared: ["react", "react-dom"],
    }),
  ],
});
```

The first host migration keeps the array-form `shared` configuration unchanged. This avoids introducing a singleton policy during the configuration conversion. Enable singletons separately only after completing the review in [Step 5](#step-5-review-shared-dependencies-and-css).

Use an object remote with an explicit `type` for a Vite ESM remote.

**X — Incorrect:** a string remote is interpreted as `var`.

```ts
remotes: {
  catalog: 'https://cdn.example.com/catalog/remoteEntry.js',
}
```

**O — Correct:** declare the Vite ESM remote with `type: 'module'`.

```ts
remotes: {
  catalog: {
    name: 'catalog',
    entry: 'https://cdn.example.com/catalog/remoteEntry.js',
    type: 'module',
  },
}
```

The static consumer import remains the same:

```ts
const Product = await import("catalog/Product");
```

### Remote format mapping

| OriginJS remote configuration | Migration action                                                                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| URL string or `format: 'esm'` | Verify that the entry is an ESM container, then use `{ name, entry, type: 'module' }`.                                                                            |
| `format: 'var'`               | Verify that the entry is a var container, then use `{ name, entry, type: 'var' }`. Add `entryGlobalName` when the container global differs from the remote alias. |
| `format: 'systemjs'`          | Treat as a manual migration that requires a separate proof of concept.                                                                                            |
| `externalType: 'promise'`     | Resolve the URL asynchronously, then call `registerRemotes()` from the runtime API.                                                                               |
| `shareScope`                  | Preserve it as `shareScope` on the `@module-federation/vite` remote object.                                                                                       |
| `from`                        | Do not map it directly. Select `type` from the actual remote entry format and verify shared-dependency behavior.                                                  |

Select `type` from the container format used by the deployed remote entry, not from the bundler that produced it.

## Step 4: Migrate dynamic remotes

This step is only required when the host registers or loads remotes dynamically. Install `@module-federation/enhanced` in that host before using its runtime API.

### pnpm

```sh
pnpm add @module-federation/enhanced
```

### npm

```sh
npm install @module-federation/enhanced
```

### Yarn

```sh
yarn add @module-federation/enhanced
```

OriginJS exposes dynamic federation through `virtual:__federation__`:

```ts
import {
  __federation_method_getRemote as getRemote,
  __federation_method_setRemote as setRemote,
  __federation_method_unwrapDefault as unwrapDefault,
} from "virtual:__federation__";

setRemote("catalog", {
  url: () => Promise.resolve(remoteUrl),
  format: "esm",
  from: "vite",
});

const module = await getRemote("catalog", "./Product");
const Product = await unwrapDefault(module);
```

### Most migrations: host using the Vite plugin

If the existing OriginJS host continues to use a Vite federation plugin, use this path:

```ts
import {
  registerRemotes,
  loadRemote,
} from "@module-federation/enhanced/runtime";

registerRemotes([{ name: "catalog", entry: remoteUrl, type: "module" }]);

const module = await loadRemote("catalog/Product");
const Product = module?.default ?? module;
```

### Host without the Vite plugin

This path applies only when the host is intentionally being redesigned to manage federation entirely at runtime. Create an instance with `createInstance()`, call `registerShared()` for dependencies that the host must provide, and then call `registerRemotes()`. Shared registration is application-specific, so follow the complete [runtime registration example](../examples/vite-runtime-register) instead of copying a partial configuration from this guide.

Keep remote registration before the first load. Preserve an error boundary or loading state around the consuming UI; remote entry, chunk, and shared-dependency failures are runtime failures.

## Step 5: Review shared dependencies and CSS

Do not copy complex OriginJS `shared` configuration mechanically.

| OriginJS option                            | Migration action                                                                                                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared: ['react', 'react-dom']`           | Supported unchanged. Configure `singleton` separately only when the host and remote must share the same React instance.                                                                           |
| `requiredVersion`, `shareScope`            | Supported by the `@module-federation/vite` shared configuration; retain them after checking the configuration on both sides.                                                                     |
| `version`                                  | String values are supported. OriginJS also accepts `version: false`, which has no direct equivalent in `@module-federation/vite`; review that case manually.                                       |
| `import: false`                            | Supported, but the remote has no local fallback. Ensure that the host provides a compatible version in the same share scope.                                                                      |
| `packagePath`                              | Review manually. It is an OriginJS package-resolution option without a direct `@module-federation/vite` configuration field.                                                                      |
| `generate: false`                          | Review manually. Do not assume that `@module-federation/vite` omits the same fallback artifact.                                                                                                   |
| `modulePreload`                            | Review the application build and loading behavior manually. It has no direct equivalent in the `@module-federation/vite` shared options.                                                          |
| `dontAppendStylesToHead`                   | There is no direct equivalent. If the exposed module uses Shadow DOM, manage its stylesheet URLs or styles explicitly and inject them into the `ShadowRoot`. `bundleAllCSS` is not a replacement. |

When the host and remote use React within the same rendering boundary, verify compatible versions and configure `react` and `react-dom` as singletons. Also verify subpath imports that cross the boundary, such as `react/jsx-runtime` and `react-dom/client`.

## Step 6: Deploy incrementally and retire OriginJS

1. Deploy the migrated remote at a versioned URL that is separate from the existing OriginJS remote. Keep the existing remote entry and chunks available.
2. Migrate one host to the new remote URL using an object-form remote with an explicit `type`.
3. Verify remote modules, shared dependencies, CSS, and asset loading in a production-like environment.
4. Migrate the remaining static and dynamic hosts to the new remote incrementally.
5. Remove the OriginJS package, configuration, and previous remote entry only after no host consumes the OriginJS remote and the rollback retention period has ended.

Publish the remote entry and the chunks it references as one deployment unit. Use immutable, content-hashed URLs for child chunks, and retain previous chunks long enough to support cached remote entries and rollback.

## Before removing OriginJS

- [ ] The migrated host can load every remote expose it uses.
- [ ] The deployed remote entry URL matches the actual build output path, and the entry can load every referenced chunk.
- [ ] Static imports and, when used, dynamic remote loading work as expected.
- [ ] Shared-dependency version selection and singleton behavior match the intended configuration.
- [ ] Remote CSS and other assets load correctly.
- [ ] The production build and federation integration tests pass.

## Related examples

- [Consuming multiple remote formats](../examples/vite-webpack-rspack/host/vite.config.js): Vite module, Vite var, Webpack var, and Rspack var remotes
- [Dynamic remote registration](../examples/vite-runtime-register): `createInstance`, `registerShared`, `registerRemotes`, and `loadRemote`

# feat(ssr): support `mf-manifest.json` as remote entry URL

## Summary

SSR hosts can use `entry: "…/mf-manifest.json"` in addition to `remoteEntry.js`. Both work interchangeably per remote.

This unlocks [Module Federation Chrome DevTools](https://module-federation.io/guide/debug/chrome-devtool) (proxy, Module Info, Dependency Graph, Shared analysis, Loading Trace) and explicit `ssrRemoteEntry` discovery in manifest metadata.

## What changed

- **`ssrEntryLoader`** — manifest-first resolution for `.json` entries; HEAD-check `ssrRemoteEntry`; fallback to `__mf_server__/<name>.ssr.js`; existing `remoteEntry.js` path unchanged.
- **`index.ts`** — `configEnvironment` sets `ENV_TARGET: "node"` on server/ssr builds so manifest snapshot does not call `document` on Node.
- **`virtualRemotes`** — server wrappers await `loadRemote()` before export (no `undefined` on first SSR render).
- **`virtualShared_preBuild`** — named workspace singleton shares use sync local fallback in build output.

## Usage

Remote (`manifest: true` required for manifest entry):

```ts
federation({ name: "remote", filename: "remoteEntry.js", manifest: true, exposes: { … } });
```

Host (either entry style):

```ts
remotes: {
  remote: {
    type: "module",
    name: "remote",
    entry: "http://localhost:4174/mf-manifest.json", // or …/remoteEntry.js
  },
},
```

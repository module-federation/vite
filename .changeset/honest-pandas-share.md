---
"@module-federation/vite": patch
---

fix: resolve parent package version for shared subpath keys

Shared keys that point at a package subpath (e.g. `"@scope/foo/bar"`) were
ending up with `version: undefined` in the generated remote `usedShared`
map. The fallback in `searchPackageVersion` passed the full subpath as
`packageName` to `getInstalledPackageJson`, which walks the pnpm store
matching the `name` field in each `package.json`. No real package is
named `"@scope/foo/bar"`, so the walk always missed and the version
silently stayed undefined — only the parent key resolved correctly.

At runtime, `version: undefined` on the consumer side breaks the
singleton/`requiredVersion` matching against the host's registered
share, falling back to the remote's local provider; for `import: false`
shares that's the throwing `get()`, surfaced as
`[Module Federation] Shared module '<subpath>' must be provided by host`.

The fix is to drop the `packageName: sharedName` override and rely on
`getInstalledPackageJson`'s existing default
(`packageName = getPackageName(pkg)`), which strips subpaths correctly.

Regression test covers a pnpm-strict fixture where the parent package is
only reachable through `node_modules/.pnpm`, so the
`searchPackageVersion` fallback is the only path that can resolve the
version.

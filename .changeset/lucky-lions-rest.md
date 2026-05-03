---
"@module-federation/vite": patch
---

fix: preserve `singleton: true` shared packages in `excludeSharedSubDependencies`

The dev-mode heuristic that auto-removes shared sub-dependencies (to prevent
initialization-order issues such as `lit`/`lit-html`) was also silently removing
packages explicitly declared with `singleton: true` — for example `react` and
`react-dom` when a company SDK or wrapper library lists them in its `dependencies`.
This caused multiple React instances to load across host and remotes, breaking all hooks.

The fix adds a `singleton: true` guard alongside the existing `import: false` guard
so that explicitly-declared singletons are never auto-excluded.

---
'@module-federation/vite': patch
---

fix: add moduleParseIdleTimeout option as an alternative to moduleParseTimeout

The existing `moduleParseTimeout` is a fixed timer from build start, which can
fire prematurely on large codebases causing missing remotes in `remoteEntry` and
"Failed to locate remote" errors at runtime.

The new `moduleParseIdleTimeout` resets on every parsed module and only fires
when there has been no module activity for the configured duration, making it
safe to use regardless of total build time.

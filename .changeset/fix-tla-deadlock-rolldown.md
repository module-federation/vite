---
'@module-federation/vite': patch
---

fix: resolve TLA deadlock causing blank pages with Vite 8+ (Rolldown)

Three fixes for top-level await initialization ordering with Rolldown:

1. **Inline hostInit script** — Changed from external `<script src="hostInit.js">` to inline `<script type="module">await import("hostInit.js").then(m => m.__tla)</script>`. This ensures `init()` completes before subsequent module scripts evaluate, since Rolldown compiles TLA into `__tla` Promise exports that browsers don't automatically await.

2. **Remove side-effect loadShare imports** — Rolldown adds bare `import"./loadShare_chunk.js"` to shared bundles, creating circular TLA dependencies. These are now stripped from non-loadShare chunks in `generateBundle`.

3. **Eager lazy-init evaluation** — Rolldown wraps loadShare modules with `var X = n(async () => {...})`, leaving exports undefined until `X()` is called. An `await X()` call is now inserted before the export statement to ensure exports are populated before dependents run.

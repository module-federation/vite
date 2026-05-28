---
"@module-federation/vite": patch
---

fix: content-hash the bootstrap entry asset

The bootstrap entry emitted by the plugin was named `mf-entry-bootstrap-<index>.js`
with no content hash. Because `index.html` references this file as the app entry,
browsers and CDNs kept serving the stale bootstrap after a deploy, breaking app load
until caches expired.

The fix appends a short sha256 hash of the bootstrap source to the filename
(`mf-entry-bootstrap-<index>-<hash>.js`) so the emitted asset participates in the
normal cache-busting flow alongside every other built asset.

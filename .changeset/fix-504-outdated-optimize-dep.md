---
'@module-federation/vite': patch
---

fix: prevent 504 Outdated Optimize Dep errors in dev mode

Create virtual module files in the config hook (before Vite optimization) instead of configResolved (after), removing the need for optimizeDeps.force = true workaround.

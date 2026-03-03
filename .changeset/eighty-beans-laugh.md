---
'@module-federation/vite': minor
---

feat: support rolldown-vite and Vite 8 alongside Vite 5-7

Detect rolldown-vite or Vite 8+ at runtime and use ESM virtual modules with top-level await for dev. Vite 5-7 continues to use CJS virtual modules with the placeholder pattern.

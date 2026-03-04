---
'@module-federation/vite': patch
---

fix: publish Windows TYPE-001 type generation fix

Ship the existing dependency update to `@module-federation/dts-plugin@^2.0.1`
so Windows federated type generation no longer fails with `--project 'C:\...json'`
single-quote command parsing.

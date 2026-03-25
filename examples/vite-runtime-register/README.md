# Vite Runtime Register Example

Pure runtime host + Vite remote.

What it shows:

- host creates a Module Federation runtime instance
- host registers React shared deps at runtime
- host registers a remote with `registerRemotes()`
- host loads exposed modules with `loadRemote()`

Run dev:

```bash
pnpm --filter examples-vite-runtime-register-remote dev
pnpm --filter examples-vite-runtime-register-host dev
```

URLs:

- host: `http://localhost:4175`
- remote: `http://localhost:4176`

Run preview:

```bash
pnpm --filter examples-vite-runtime-register-remote preview
pnpm --filter examples-vite-runtime-register-host preview
```

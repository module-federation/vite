---
"@module-federation/vite": patch
---

fix: detect `export enum` and destructuring exports when scanning shared named exports

The static export scanner that builds the shared `loadShare` proxy
(`getNamedExportsViaRegex`) only recognized `function | const | let | var | class`
declarations. Two common forms reached through `export * from './...'` were
therefore dropped from the proxy:

- TypeScript `export enum` (and `export namespace`) declarations — runtime
  values, not just types.
- Destructuring exports such as `export const { addItem: createActionAddItem } = slice.actions;`,
  the shape Redux Toolkit's `createSlice` produces. These match neither the
  declaration regex (the next token is `{`/`[`) nor the `export { ... }` list
  regex (the leading `const` breaks it).

Importing those names across the Module Federation share boundary failed at
runtime with `The requested module ... does not provide an export named '<name>'`.

The fix adds `enum`/`namespace` to the declaration regex and a dedicated pass
for object/array destructuring exports (handling renames, defaults and rest
elements).

Closes #780.

export { SharedCounter } from "./components";

export type { TCardVariant } from "./components";
// Re-exports via `export * from` through nested directories.
// This structure tests two bugs in the module federation plugin:
//
// 1. `export * from './helpers'` resolves to `./helpers/index.ts` (directory import).
//    Without the fix, `existsSync('./helpers')` returns true for the directory,
//    and the plugin tries to read it as a file, silently failing.
//
// 2. `helpers/index.ts` contains `export * from './search'`, which in turn
//    re-exports from `./search/index.ts` -> `./filter.ts`.
//    Without recursive resolution of `export *`, deeply nested exports
//    like `createSimpleSearch` are missing from the generated loadShare module,
//    causing MISSING_EXPORT errors at runtime.
export * from "./helpers";

// We expect it to be called once (since singleton=true is set).
console.trace("[Shared Lib] Initialized");

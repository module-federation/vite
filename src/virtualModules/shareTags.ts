// Infixes marking a generated virtual module's role, and with it the chunk it
// lands in. A leaf module so anything that produces or matches one can import it
// without pulling in the generators.

export const LOAD_SHARE_TAG = '__loadShare__';

/** A share's local copy. Reachable only through `import()`, so it stays lazy. */
export const PREBUILD_TAG = '__prebuild__';

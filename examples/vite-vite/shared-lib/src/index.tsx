export { SharedCounter } from "./SharedCounter";
export { formatLabel } from "./utils";

export type { TCardVariant } from "./SharedCounter";
export type { TBadgeColor } from "./utils";

// We expect it to be called once (since singleton=true is set).
console.trace("[Shared Lib] Initialized");

export function createReactMixedModeRuntimeGuard(): string {
  return `const __mfReactInternals = mod["__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE"];
if (__mfReactInternals && "A" in __mfReactInternals) {
  let __mfReactDispatcher = __mfReactInternals.A;
  Object.defineProperty(__mfReactInternals, "A", {
    configurable: true,
    enumerable: true,
    get: () => __mfReactDispatcher,
    set: (next) => {
      if (next && typeof next.getOwner !== "function") next.getOwner = () => null;
      __mfReactDispatcher = next;
    },
  });
  __mfReactInternals.A = __mfReactDispatcher;
}`;
}

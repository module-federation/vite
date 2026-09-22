import { REACT_CLIENT_INTERNALS_KEY } from '../utils/reactShares';

export function createReactMixedModeRuntimeGuard(): string {
  return `const __mfReactInternals = mod[${JSON.stringify(REACT_CLIENT_INTERNALS_KEY)}];
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

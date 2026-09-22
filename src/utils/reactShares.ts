// React-specific share knowledge, in one place so the generators, the
// mixed-mode guard and the shared-cache identity check cannot drift apart.

/** Property under which React 19 exposes its internals object. */
export const REACT_CLIENT_INTERNALS_KEY =
  '__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE';

/**
 * Every property React has used for its internals object, newest first. Two
 * module objects that expose the same internals are the same React instance.
 */
export const REACT_INTERNALS_KEYS = [
  REACT_CLIENT_INTERNALS_KEY,
  '__TEST_INTERNALS',
  '__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED',
] as const;

/**
 * Importing this share's local fallback registers a DOM renderer as a side
 * effect. An entry-injected leaf must not evaluate its own copy while the host
 * renderer already owns the root, so its wrapper waits for the cache or init.
 */
export const REACT_DOM_CLIENT_SHARE = 'react-dom/client';

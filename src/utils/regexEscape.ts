// Characters that carry meaning inside a regular expression and must be
// escaped when a runtime value is interpolated into a `new RegExp(...)` source.
const REGEXP_SPECIAL_CHARS_RE = /[.*+?^${}()|[\]\\]/g;

/**
 * Escape `value` so it matches literally when interpolated into a regex source.
 *
 * Federation interpolates user-controlled strings — package names, chunk file
 * names, virtual module ids — into generated matchers. Those routinely contain
 * `.`, `+`, `[` and `\`, which would otherwise change what the pattern matches.
 */
export function escapeRegExp(value: string): string {
  return value.replace(REGEXP_SPECIAL_CHARS_RE, '\\$&');
}

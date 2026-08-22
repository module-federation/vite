// JSON.stringify alone does not escape a literal `<`, and can return `undefined`
// (not the string "undefined") for values like `undefined` itself. Values embedded
// via JSON.stringify into generated JS can break out of a `<script>` tag if that
// code is later inlined into HTML (via a literal `</script>`), or terminate a
// string literal early via a raw U+2028/U+2029 line separator. Use this wherever a
// value is interpolated into code we generate, instead of JSON.stringify directly.
const UNSAFE_JS_CHAR_MAP: Record<string, string> = {
  '<': '\\u003C',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};
const UNSAFE_JS_CHAR_PATTERN = /[<\u2028\u2029]/g;

export function toSafeJsLiteral(value: unknown): string {
  const json = JSON.stringify(value);
  // JSON.stringify(undefined) (and of functions/symbols) returns undefined rather
  // than a string. Interpolating that into a template literal previously produced
  // the bare `undefined` keyword in the generated code; preserve that behavior.
  if (json === undefined) return 'undefined';
  return json.replace(UNSAFE_JS_CHAR_PATTERN, (char) => UNSAFE_JS_CHAR_MAP[char]);
}

/**
 * Serializes a JavaScript object into a string of source code that can be evaluated.
 * This function is used to create runtime plugin options without relying solely on JSON.stringify,
 * allowing support for non-JSON types like RegExp, Date, Map, Set, and Functions.
 * It also safely handles circular references.
 *
 * @param {Record<string, unknown>} options - The options object to serialize.
 * @returns {string} The resulting JavaScript source code string.
 */
export function serializeRuntimeOptions(options: Record<string, unknown>): string {
  // Track only the active recursion path. Reusing the same object in separate
  // branches is valid and should serialize its value again rather than being
  // mistaken for a circular reference.
  const ancestors = new WeakSet<object>();

  /**
   * Recursive inner function to serialize any value into a source code string.
   */
  function valueToCode(val: any): string {
    // 1. Handle primitive values
    if (val === null) return 'null';

    const type = typeof val;

    if (type === 'string') return toSafeJsLiteral(val);
    if (type === 'number' || type === 'boolean') return String(val);
    if (type === 'undefined') return 'undefined';

    // Handle Symbol
    if (type === 'symbol') {
      const desc = val.description ?? '';
      return `Symbol(${toSafeJsLiteral(desc)})`;
    }

    // Handle Function (returns the function's source code)
    if (type === 'function') return val.toString();

    // 2. Handle special built-in objects
    if (val instanceof Date) return `new Date(${toSafeJsLiteral(val.toISOString())})`;
    if (val instanceof RegExp) {
      return `new RegExp(${toSafeJsLiteral(val.source)}, ${toSafeJsLiteral(val.flags)})`;
    }

    // 3. Handle objects while detecting cycles in the active recursion path.
    if (type === 'object') {
      if (ancestors.has(val)) {
        return `"__circular__"`;
      }
      ancestors.add(val);

      try {
        if (Array.isArray(val)) {
          return `[${val.map(valueToCode).join(', ')}]`;
        }

        if (val instanceof Map) {
          const entries = Array.from(val.entries()).map(
            ([k, v]) => `[${valueToCode(k)}, ${valueToCode(v)}]`
          );
          return `new Map([${entries.join(', ')}])`;
        }

        if (val instanceof Set) {
          const items = Array.from(val.values()).map(valueToCode);
          return `new Set([${items.join(', ')}])`;
        }

        const properties: string[] = [];
        for (const key in val) {
          if (Object.prototype.hasOwnProperty.call(val, key)) {
            properties.push(`${toSafeJsLiteral(key)}: ${valueToCode(val[key])}`);
          }
        }
        return `{${properties.join(', ')}}`;
      } finally {
        ancestors.delete(val);
      }
    }

    // 4. Fallback case (e.g., BigInt)
    // Coerce to string and then serialize that string for safety
    return toSafeJsLiteral(String(val));
  }

  // Start serialization for the top-level object
  const topLevelProps: string[] = [];

  // Iterate over the properties of the root 'options' object
  for (const key in options) {
    if (Object.prototype.hasOwnProperty.call(options, key)) {
      topLevelProps.push(`${toSafeJsLiteral(key)}: ${valueToCode(options[key])}`);
    }
  }

  return `{${topLevelProps.join(', ')}}`;
}

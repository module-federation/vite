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
  // Use a WeakSet to track objects already encountered, which helps in detecting circular references.
  const seenObjects = new WeakSet<any>();

  /**
   * Recursive inner function to serialize any value into a source code string.
   */
  function valueToCode(val: any): string {
    // 1. Handle primitive values
    if (val === null) return 'null';

    const type = typeof val;

    if (type === 'string') return JSON.stringify(val);
    if (type === 'number' || type === 'boolean') return String(val);
    if (type === 'undefined') return 'undefined';

    // Handle Symbol
    if (type === 'symbol') {
      const desc = val.description ?? '';
      return `Symbol(${JSON.stringify(desc)})`;
    }

    // Handle Function (returns the function's source code)
    if (type === 'function') return val.toString();

    // 2. Handle special built-in objects
    if (val instanceof Date) return `new Date(${JSON.stringify(val.toISOString())})`;
    if (val instanceof RegExp) {
      return `new RegExp(${JSON.stringify(val.source)}, ${JSON.stringify(val.flags)})`;
    }

    // 3. Check for circular references and mark object as seen
    // This applies to objects, arrays, maps, and sets.
    if (type === 'object') {
      if (seenObjects.has(val)) {
        // This object has been seen previously in the recursion path
        return `"__circular__"`;
      }
      seenObjects.add(val);
    }

    // 4. Handle Array, Map, Set
    if (Array.isArray(val)) {
      // Recursively serialize each element
      return `[${val.map(valueToCode).join(', ')}]`;
    }

    if (val instanceof Map) {
      // Serialize Map entries into an array of [key, value] pairs
      const entries = Array.from(val.entries()).map(
        ([k, v]) => `[${valueToCode(k)}, ${valueToCode(v)}]`
      );
      return `new Map([${entries.join(', ')}])`;
    }

    if (val instanceof Set) {
      // Serialize Set values into an array
      const items = Array.from(val.values()).map(valueToCode);
      return `new Set([${items.join(', ')}])`;
    }

    // 5. Handle plain objects (the default object type)
    if (type === 'object') {
      const properties: string[] = [];

      // Iterate over the object's own enumerable properties
      for (const key in val) {
        if (Object.prototype.hasOwnProperty.call(val, key)) {
          // Wrap the key in JSON.stringify to handle non-identifier keys
          properties.push(`${JSON.stringify(key)}: ${valueToCode(val[key])}`);
        }
      }
      return `{${properties.join(', ')}}`;
    }

    // 6. Fallback case (e.g., BigInt, other object types)
    // Coerce to string and then JSON.stringify that string for safety
    return JSON.stringify(String(val));
  }

  // Start serialization for the top-level object
  const topLevelProps: string[] = [];

  // Iterate over the properties of the root 'options' object
  for (const key in options) {
    if (Object.prototype.hasOwnProperty.call(options, key)) {
      topLevelProps.push(`${JSON.stringify(key)}: ${valueToCode(options[key])}`);
    }
  }

  return `{${topLevelProps.join(', ')}}`;
}

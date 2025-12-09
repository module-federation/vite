export function generateRuntimePluginOption(value: Record<string, unknown>): string {
  const seen = new WeakSet<any>();

  function inner(val: any): string {
    if (val === null) return 'null';
    const t = typeof val;

    if (t === 'string') return JSON.stringify(val);
    if (t === 'number' || t === 'boolean') return String(val);
    if (t === 'undefined') return 'undefined';
    if (t === 'symbol') return `Symbol(${JSON.stringify(val.description ?? '')})`;
    if (t === 'function') return val.toString();

    if (val instanceof Date) return `new Date(${JSON.stringify(val.toISOString())})`;
    if (val instanceof RegExp)
      return `new RegExp(${JSON.stringify(val.source)}, ${JSON.stringify(val.flags)})`;

    if (seen.has(val)) return `"__circular__"`;
    if (t === 'object') seen.add(val);

    if (Array.isArray(val)) return `[${val.map(inner).join(', ')}]`;

    if (val instanceof Map) {
      const entries = Array.from(val.entries()).map(([k, v]) => `[${inner(k)}, ${inner(v)}]`);
      return `new Map([${entries.join(', ')}])`;
    }

    if (val instanceof Set) {
      const items = Array.from(val.values()).map(inner);
      return `new Set([${items.join(', ')}])`;
    }

    if (t === 'object') {
      const props: string[] = [];
      for (const key in val) {
        if (Object.prototype.hasOwnProperty.call(val, key)) {
          props.push(`${JSON.stringify(key)}: ${inner(val[key])}`);
        }
      }
      return `{${props.join(', ')}}`;
    }

    return JSON.stringify(String(val));
  }

  const recordProps: string[] = [];
  for (const key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      recordProps.push(`${JSON.stringify(key)}: ${inner(value[key])}`);
    }
  }

  return `{${recordProps.join(', ')}}`;
}

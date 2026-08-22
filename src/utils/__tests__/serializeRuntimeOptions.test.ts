import { serializeRuntimeOptions, toSafeJsLiteral } from '../serializeRuntimeOptions';

describe('toSafeJsLiteral', () => {
  it('matches JSON.stringify for ordinary values', () => {
    expect(toSafeJsLiteral('react')).toBe(String.raw`"react"`);
    expect(toSafeJsLiteral(42)).toBe('42');
    expect(toSafeJsLiteral(['a', 'b/c'])).toBe(String.raw`["a","b/c"]`);
    expect(toSafeJsLiteral({ name: 'host' })).toBe(String.raw`{"name":"host"}`);
  });

  it('embeds undefined as the bare keyword, matching template-literal interpolation of JSON.stringify(undefined)', () => {
    expect(toSafeJsLiteral(undefined)).toBe('undefined');
  });

  it(String.raw`escapes a literal "<" so a string value cannot form "</script>"`, () => {
    const escaped = toSafeJsLiteral('</script>');
    expect(escaped).not.toContain('<');
    expect(JSON.parse(escaped)).toBe('</script>');
  });

  it('escapes U+2028/U+2029 so the result stays a single valid string literal', () => {
    const value = 'line\u2028sep\u2029break';
    const escaped = toSafeJsLiteral(value);
    expect(escaped).not.toContain('\u2028');
    expect(escaped).not.toContain('\u2029');
    expect(new Function(`return ${escaped};`)()).toBe(value);
  });

  it('produces a value that evaluates back to the original when embedded in generated code', () => {
    const original = { pkg: '</script>', note: 'a\u2028b' };
    const roundTripped = new Function(`return ${toSafeJsLiteral(original)};`)();
    expect(roundTripped).toEqual(original);
  });
});

describe('generateRuntimePluginOption - safe JS literal', () => {
  it('should serialize complex megaObject', () => {
    const normalizeWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim();
    const emptyArray: any[] = [];
    const emptyObject: any = {};

    const megaObject = {
      arrInsideObj: [{ x: 10 }, new Set(['s1', 's2'])],
      mapInsideObj: new Map([
        ['mapKey', new Set([12321])],
        ['mapSet', new Set([1, 2, 3])],
      ]),
      objInsideSet: new Set([{ a: 1 }, new Map([['mk', { nested: 'value' }]])]),
    };

    const input = {
      numberVal: 123,
      stringVal: 'hello world',
      booleanVal: true,
      nullVal: null,
      undefinedVal: undefined,
      symbolVal: Symbol('prod'),
      funcVal: function greet(name: string) {
        return 'hello ' + name;
      },
      dateVal: new Date('2023-10-10T10:00:00.000Z'),
      regexVal: /prod-test/gi,
      arrayVal: [1, 'a', true, [2, 3, [4, 5]]],
      nestedObj: { level1: { level2: { value: 'deep' } } },
      mapVal: new Map([['key1', 100]]),
      setVal: new Set([1, 'x', new Date('2020-01-01')]),
      emptyArray,
      emptyObject,
      megaObject,
    };

    console.time('bench-test');
    const code = serializeRuntimeOptions(input);
    console.timeEnd('bench-test');

    // Simple checks that key features exist
    expect(normalizeWhitespace(code)).toContain(
      normalizeWhitespace(`{"numberVal": 123, "stringVal": "hello world", "booleanVal": true, "nullVal": null, "undefinedVal": undefined, "symbolVal": Symbol("prod"), "funcVal": function greet(name) {
        return "hello " + name;
      }, "dateVal": new Date("2023-10-10T10:00:00.000Z"), "regexVal": new RegExp("prod-test", "gi"), "arrayVal": [1, "a", true, [2, 3, [4, 5]]], "nestedObj": {"level1": {"level2": {"value": "deep"}}}, "mapVal": new Map([["key1", 100]]), "setVal": new Set([1, "x", new Date("2020-01-01T00:00:00.000Z")]), "emptyArray": [], "emptyObject": {}, "megaObject": {"arrInsideObj": [{"x": 10}, new Set(["s1", "s2"])], "mapInsideObj": new Map([["mapKey", new Set([12321])], ["mapSet", new Set([1, 2, 3])]]), "objInsideSet": new Set([{"a": 1}, new Map([["mk", {"nested": "value"}]])])}}`)
    );
  });

  it('serializes repeated references without treating them as circular', () => {
    const shared = { nested: { value: 1 } };

    expect(serializeRuntimeOptions({ first: shared, second: shared })).toBe(
      '{"first": {"nested": {"value": 1}}, "second": {"nested": {"value": 1}}}'
    );
  });

  it('still marks references that are circular in the active path', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(serializeRuntimeOptions({ circular })).toBe('{"circular": {"self": "__circular__"}}');
  });
});

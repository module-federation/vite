import { serializeRuntimeOptions } from '../serializeRuntimeOptions';

describe('generateRuntimePluginOption - safe JS literal', () => {
  it('should serialize complex megaObject', () => {
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
    expect(code)
      .toContain(`{"numberVal": 123, "stringVal": "hello world", "booleanVal": true, "nullVal": null, "undefinedVal": undefined, "symbolVal": Symbol("prod"), "funcVal": function greet(name) {
        return "hello " + name;
      }, "dateVal": new Date("2023-10-10T10:00:00.000Z"), "regexVal": new RegExp("prod-test", "gi"), "arrayVal": [1, "a", true, [2, 3, [4, 5]]], "nestedObj": {"level1": {"level2": {"value": "deep"}}}, "mapVal": new Map([["key1", 100]]), "setVal": new Set([1, "x", new Date("2020-01-01T00:00:00.000Z")]), "emptyArray": [], "emptyObject": {}, "megaObject": {"arrInsideObj": [{"x": 10}, new Set(["s1", "s2"])], "mapInsideObj": new Map([["mapKey", new Set([12321])], ["mapSet", new Set([1, 2, 3])]]), "objInsideSet": new Set([{"a": 1}, new Map([["mk", {"nested": "value"}]])])}}`);
  });
});

import { describe, expect, it } from 'vitest';
import { createCodePositionMap } from '../codePositionMap';
import { findLikelyTypeArgumentEnd } from '../typeArgumentScanner';

function findTypeArgumentRange(source: string): string | undefined {
  const start = source.indexOf('<');
  const end = findLikelyTypeArgumentEnd(source, start, createCodePositionMap(source));
  return end === undefined ? undefined : source.slice(start, end + 1);
}

describe('findLikelyTypeArgumentEnd', () => {
  it.each([
    ['const registry = new WeakMap<object, any>();', '<object, any>'],
    ['const value = factory<Result, Options>();', '<Result, Options>'],
    [
      'const registry: Map<string, WeakMap<object, any>> = new Map();',
      '<string, WeakMap<object, any>>',
    ],
    ['const identity = <T = string, U = number>(value: T) => value;', '<T = string, U = number>'],
  ])('finds a balanced type argument range in %s', (source, expected) => {
    expect(findTypeArgumentRange(source)).toBe(expected);
  });

  it('allows TypeScript assertion keywords after the range', () => {
    expect(findTypeArgumentRange('const value = factory<Result, Options> as unknown;')).toBe(
      '<Result, Options>'
    );
  });

  it('finds nested type arguments in a TypeScript angle-bracket assertion', () => {
    expect(findTypeArgumentRange('const registry = <Map<object, any>>new Map();')).toBe(
      '<Map<object, any>>'
    );
  });

  it.each([
    'const value = left < right;',
    'const first = left < right, second = value > fallback;',
    'const value = factory<Result, Options;',
  ])('fails closed for ambiguous syntax in %s', (source) => {
    expect(findTypeArgumentRange(source)).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { escapeRegExp } from '../regexEscape';

describe('escapeRegExp', () => {
  it('leaves plain values untouched', () => {
    expect(escapeRegExp('remoteEntry')).toBe('remoteEntry');
  });

  it('escapes every regex metacharacter', () => {
    expect(escapeRegExp('.*+?^${}()|[]\\')).toBe('\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\');
  });

  it('matches a scoped package name literally', () => {
    const specifier = '@scope/pkg-1.2.x';
    expect(new RegExp(`^${escapeRegExp(specifier)}$`).test(specifier)).toBe(true);
    expect(new RegExp(`^${escapeRegExp(specifier)}$`).test('@scopeXpkg-1a2ax')).toBe(false);
  });

  it('matches a hashed chunk file name literally', () => {
    const fileName = 'assets/remoteEntry-a1b2c3.js';
    expect(new RegExp(escapeRegExp(fileName)).test(fileName)).toBe(true);
    expect(new RegExp(escapeRegExp(fileName)).test('assets/remoteEntry-a1b2c3Xjs')).toBe(false);
  });

  it('keeps a virtual module id with a null-byte prefix matchable', () => {
    const id = '\0virtual:mf-REMOTE_ENTRY_ID:host__remoteEntry.js';
    expect(new RegExp(`^${escapeRegExp(id)}`).test(id)).toBe(true);
  });
});

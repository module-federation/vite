import { describe, expect, it } from 'vitest';
import { HMR_ADAPTERS, hasCrossFederationHmr, resolveAdapters } from '../pluginDevRemoteHmr';

describe('HMR adapter registry', () => {
  it('lists react and vue adapters out of the box', () => {
    expect(HMR_ADAPTERS.map((a) => a.name).sort()).toEqual(['react', 'vue']);
  });

  it('resolves the matching adapter by plugin name', () => {
    expect(resolveAdapters([{ name: 'vite:react-refresh' }]).map((a) => a.name)).toEqual(['react']);
    expect(resolveAdapters([{ name: 'vite:react-swc:refresh' }]).map((a) => a.name)).toEqual([
      'react',
    ]);
    expect(resolveAdapters([{ name: 'vite:vue' }]).map((a) => a.name)).toEqual(['vue']);
    expect(resolveAdapters([{ name: 'vite:vue-jsx' }]).map((a) => a.name)).toEqual(['vue']);
  });

  it('returns multiple adapters when several frameworks are present', () => {
    const adapters = resolveAdapters([
      { name: 'vite:react-refresh' },
      { name: 'vite:vue' },
      { name: 'unrelated' },
    ]);
    expect(adapters.map((a) => a.name).sort()).toEqual(['react', 'vue']);
  });

  it('returns no adapters when no known plugin is present', () => {
    expect(resolveAdapters([{ name: 'vite:something-else' }])).toEqual([]);
    expect(resolveAdapters([])).toEqual([]);
  });

  it('hasCrossFederationHmr mirrors resolveAdapters', () => {
    expect(hasCrossFederationHmr([{ name: 'vite:react-refresh' }])).toBe(true);
    expect(hasCrossFederationHmr([{ name: 'vite:vue' }])).toBe(true);
    expect(hasCrossFederationHmr([{ name: 'vite:other' }])).toBe(false);
    expect(hasCrossFederationHmr([])).toBe(false);
  });
});

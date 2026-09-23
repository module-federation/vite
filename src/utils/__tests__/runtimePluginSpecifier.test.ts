import { describe, expect, it } from 'vitest';
import {
  filterRuntimePluginsForTarget,
  getRuntimePluginSpecifier,
  type RuntimePluginEntry,
} from '../runtimePluginSpecifier';

describe('getRuntimePluginSpecifier', () => {
  it('unwraps bare and tuple entries', () => {
    expect(getRuntimePluginSpecifier('a')).toBe('a');
    expect(getRuntimePluginSpecifier(['b', { x: 1 }])).toBe('b');
  });
});

describe('filterRuntimePluginsForTarget', () => {
  const plugins: RuntimePluginEntry[] = ['keep', ['ssr-only', { x: 1 }], 'also-keep'];
  const ssrOnly = new Set(['ssr-only']);

  it('drops SSR-only plugins for client graphs', () => {
    expect(filterRuntimePluginsForTarget(plugins, ssrOnly, false)).toEqual(['keep', 'also-keep']);
  });

  it('keeps every plugin for server graphs', () => {
    expect(filterRuntimePluginsForTarget(plugins, ssrOnly, true)).toEqual(plugins);
  });
});

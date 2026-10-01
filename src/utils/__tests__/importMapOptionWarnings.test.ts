import { describe, expect, it } from 'vitest';
import { getImportMapIgnoredOptionWarnings } from '../importMapOptionWarnings';

describe('getImportMapIgnoredOptionWarnings', () => {
  it('returns nothing for a plain import-map config', () => {
    expect(
      getImportMapIgnoredOptionWarnings({
        name: 'host',
        shared: { react: {}, 'react-dom': { singleton: true } },
        experiments: { importMap: true },
      })
    ).toEqual([]);
  });

  it('warns about every MF-runtime-only option that was set', () => {
    const warnings = getImportMapIgnoredOptionWarnings({
      name: 'host',
      shareStrategy: 'loaded-first',
      runtimePlugins: ['./plugin.js'],
      manifest: true,
      shared: {
        react: { eager: true },
        lodash: { requiredVersion: '^4' },
        d3: {},
      },
      experiments: { importMap: true },
    });
    expect(warnings).toHaveLength(4);
    expect(warnings.join('\n')).toMatch(/shareStrategy/);
    expect(warnings.join('\n')).toMatch(/runtimePlugins/);
    expect(warnings.join('\n')).toMatch(/manifest/);
    expect(warnings.join('\n')).toMatch(/on react, lodash/);
  });
});

import { describe, expect, it } from 'vitest';
import { mergeOptimizeDepsEntries } from '../optimizeDepsEntries';

describe('mergeOptimizeDepsEntries', () => {
  it('appends generated entries after explicit user entries', () => {
    const userEntries = ['custom-entry.ts', 'shared-entry.ts'];
    const generatedEntries = ['shared-entry.ts', '/workspace/shared/src/index.tsx'];

    expect(mergeOptimizeDepsEntries(userEntries, generatedEntries, ['**/*.html'])).toEqual([
      'custom-entry.ts',
      'shared-entry.ts',
      '/workspace/shared/src/index.tsx',
    ]);
    expect(userEntries).toEqual(['custom-entry.ts', 'shared-entry.ts']);
    expect(generatedEntries).toEqual(['shared-entry.ts', '/workspace/shared/src/index.tsx']);
  });

  it('accepts a single string user entry', () => {
    expect(mergeOptimizeDepsEntries('main.ts', ['/workspace/shared/src/index.tsx'], [])).toEqual([
      'main.ts',
      '/workspace/shared/src/index.tsx',
    ]);
  });

  it('falls back to default entries when the user set none', () => {
    expect(
      mergeOptimizeDepsEntries(
        undefined,
        ['/workspace/shared/src/index.tsx'],
        ['**/*.html', '!**/node_modules/**']
      )
    ).toEqual(['**/*.html', '!**/node_modules/**', '/workspace/shared/src/index.tsx']);
  });
});

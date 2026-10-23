import { describe, expect, it } from 'vitest';
import { createSharedOptimizerPlan } from '../sharedOptimizerPlan';

describe('createSharedOptimizerPlan', () => {
  it('merges generated entries after explicit user entries', () => {
    const userEntries = ['custom-entry.ts', 'shared-entry.ts'];
    const generatedEntries = ['shared-entry.ts', '/workspace/shared/src/index.tsx'];

    expect(
      createSharedOptimizerPlan({
        user: { entries: userEntries },
        generated: { entries: generatedEntries },
        defaultEntries: ['**/*.html'],
      })
    ).toEqual({
      entries: ['custom-entry.ts', 'shared-entry.ts', '/workspace/shared/src/index.tsx'],
    });
    expect(userEntries).toEqual(['custom-entry.ts', 'shared-entry.ts']);
    expect(generatedEntries).toEqual(['shared-entry.ts', '/workspace/shared/src/index.tsx']);
  });

  it('uses default entries only when generated entries are added', () => {
    expect(
      createSharedOptimizerPlan({
        user: {},
        generated: { entries: ['/workspace/shared/src/index.tsx'] },
        defaultEntries: ['**/*.html', '!**/node_modules/**'],
      }).entries
    ).toEqual(['**/*.html', '!**/node_modules/**', '/workspace/shared/src/index.tsx']);
  });

  it('does not add default entries when there are no generated entries', () => {
    expect(
      createSharedOptimizerPlan({
        user: {},
        defaultEntries: ['**/*.html'],
      }).entries
    ).toBeUndefined();
  });
});

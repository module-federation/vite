import { describe, expect, it } from 'vitest';
import { getSharedExportConditions } from '../sharedExportConditions';

describe('getSharedExportConditions', () => {
  it('uses the active Vite environment conditions and appends ESM fallbacks', () => {
    expect(
      getSharedExportConditions({
        environmentConditions: ['module', 'node', 'development|production'],
        isSsr: true,
      })
    ).toEqual(['module', 'node', 'development|production', 'import', 'default']);
  });

  it('preserves the browser-first default when no environment conditions are available', () => {
    expect(getSharedExportConditions({ isSsr: false })).toEqual([
      'browser',
      'import',
      'module',
      'default',
    ]);
    expect(
      getSharedExportConditions({
        isSsr: false,
        rootConditions: ['custom'],
      })
    ).toEqual(['custom', 'browser', 'import', 'module', 'default']);
  });

  it('uses node conditions for legacy SSR builds and honors explicit SSR conditions', () => {
    expect(getSharedExportConditions({ isSsr: true })).toEqual([
      'node',
      'import',
      'module',
      'default',
    ]);
    expect(
      getSharedExportConditions({
        isSsr: true,
        ssrConditions: ['react-server'],
      })
    ).toEqual(['react-server', 'node', 'import', 'module', 'default']);
  });

  it('keeps webworker SSR on worker/browser conditions instead of node', () => {
    expect(
      getSharedExportConditions({
        isSsr: true,
        ssrTarget: 'webworker',
      })
    ).toEqual(['worker', 'browser', 'import', 'module', 'default']);
  });
});

import { describe, expect, it } from 'vitest';
import { getSharedExportConditions } from '../sharedExportConditions';

describe('getSharedExportConditions', () => {
  it.each([
    [true, 'production'],
    [false, 'development'],
  ])('expands Vite development|production for isProduction=%s', (isProduction, modeCondition) => {
    expect(
      getSharedExportConditions({
        environmentConditions: ['module', 'node', 'development|production'],
        isSsr: true,
        isProduction,
      })
    ).toEqual(['module', 'node', modeCondition, 'import', 'default']);
  });

  it('preserves the browser-first default when no environment conditions are available', () => {
    expect(getSharedExportConditions({ isProduction: false, isSsr: false })).toEqual([
      'browser',
      'import',
      'module',
      'default',
    ]);
    expect(
      getSharedExportConditions({
        isProduction: false,
        isSsr: false,
        rootConditions: ['custom'],
      })
    ).toEqual(['custom', 'browser', 'import', 'module', 'default']);
  });

  it('uses node conditions for legacy SSR builds and honors explicit SSR conditions', () => {
    expect(getSharedExportConditions({ isProduction: true, isSsr: true })).toEqual([
      'node',
      'import',
      'module',
      'default',
    ]);
    expect(
      getSharedExportConditions({
        isProduction: true,
        isSsr: true,
        ssrConditions: ['react-server'],
      })
    ).toEqual(['react-server', 'node', 'import', 'module', 'default']);
  });

  it('expands Vite development|production in configured fallback conditions', () => {
    expect(
      getSharedExportConditions({
        isProduction: true,
        isSsr: true,
        ssrConditions: ['react-server', 'development|production'],
      })
    ).toEqual(['react-server', 'production', 'node', 'import', 'module', 'default']);
  });

  it('keeps webworker SSR on worker/browser conditions instead of node', () => {
    expect(
      getSharedExportConditions({
        isProduction: true,
        isSsr: true,
        ssrTarget: 'webworker',
      })
    ).toEqual(['worker', 'browser', 'import', 'module', 'default']);
  });
});

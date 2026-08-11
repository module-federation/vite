import { describe, expect, it } from 'vitest';
import {
  getSsrCapabilities,
  SERVER_ENV_GUARD,
  SSR_ENTRY_LOADER_SPECIFIER,
  SSR_ONLY_RUNTIME_PLUGINS,
} from '../ssrCapabilities';

it('uses Vite environment detection for generated SSR guards', () => {
  expect(SERVER_ENV_GUARD).toBe('import.meta.env.SSR');
  expect(SERVER_ENV_GUARD).not.toContain('process');
});

describe('SSR plugin constants', () => {
  it('exports the SSR entry loader specifier', () => {
    expect(SSR_ENTRY_LOADER_SPECIFIER).toBe('@module-federation/vite/ssrEntryLoader');
  });

  it('tracks SSR-only runtime plugins', () => {
    expect(SSR_ONLY_RUNTIME_PLUGINS.has(SSR_ENTRY_LOADER_SPECIFIER)).toBe(true);
    expect(SSR_ONLY_RUNTIME_PLUGINS.size).toBe(1);
  });
});

describe('getSsrCapabilities', () => {
  it('disables everything when there are no remotes', () => {
    expect(getSsrCapabilities(8, 'serve', false)).toEqual({
      enableSsrInitBootstrap: false,
      injectSsrEntryLoader: false,
    });
    expect(getSsrCapabilities(5, 'build', false)).toEqual({
      enableSsrInitBootstrap: false,
      injectSsrEntryLoader: false,
    });
  });

  it('enables SSR on Vite 8+ dev', () => {
    expect(getSsrCapabilities(8, 'serve', true)).toEqual({
      enableSsrInitBootstrap: true,
      injectSsrEntryLoader: true,
    });
  });

  it('disables SSR dev features on Vite 5–7 serve', () => {
    expect(getSsrCapabilities(7, 'serve', true)).toEqual({
      enableSsrInitBootstrap: false,
      injectSsrEntryLoader: false,
    });
  });

  it('enables SSR on build for older Vite majors', () => {
    expect(getSsrCapabilities(5, 'build', true)).toEqual({
      enableSsrInitBootstrap: true,
      injectSsrEntryLoader: true,
    });
  });
});

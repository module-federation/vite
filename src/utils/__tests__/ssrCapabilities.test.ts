import { describe, expect, it } from 'vitest';
import {
  getSsrCapabilities,
  isServerEnvironment,
  isSsrConfig,
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
    expect(getSsrCapabilities(8, 'serve', true, true)).toEqual({
      enableSsrInitBootstrap: true,
      injectSsrEntryLoader: true,
    });
  });

  it('disables SSR dev features on Vite 5–7 serve', () => {
    expect(getSsrCapabilities(7, 'serve', true, true)).toEqual({
      enableSsrInitBootstrap: false,
      injectSsrEntryLoader: false,
    });
  });

  it('disables SSR features for a client-only build', () => {
    expect(getSsrCapabilities(8, 'build', true, false)).toEqual({
      enableSsrInitBootstrap: false,
      injectSsrEntryLoader: false,
    });
  });

  it('enables SSR on an SSR build for older Vite majors', () => {
    expect(getSsrCapabilities(5, 'build', true, true)).toEqual({
      enableSsrInitBootstrap: true,
      injectSsrEntryLoader: true,
    });
  });
});

describe('isSsrConfig', () => {
  it('detects legacy SSR builds', () => {
    expect(isSsrConfig({ build: { ssr: true } })).toBe(true);
    expect(isSsrConfig({ build: { ssr: false } })).toBe(false);
  });

  it('detects server environments', () => {
    expect(
      isSsrConfig({ environments: { ssr: { consumer: 'server' }, client: { consumer: 'client' } } })
    ).toBe(true);
    expect(isSsrConfig({ environments: { federation: { build: { ssr: true } } } })).toBe(true);
    expect(isSsrConfig({ environments: { client: { consumer: 'client' } } })).toBe(false);
  });

  it('falls back to the ssr/server environment names', () => {
    expect(isSsrConfig({ environments: { ssr: {} } })).toBe(true);
    expect(isSsrConfig({ environments: { server: {} } })).toBe(true);
    expect(isSsrConfig({ environments: { worker: {} } })).toBe(false);
  });
});

describe('isServerEnvironment', () => {
  it('prefers consumer and build.ssr over the environment name', () => {
    expect(isServerEnvironment('client', { consumer: 'server' })).toBe(true);
    expect(isServerEnvironment('client', { build: { ssr: true } })).toBe(true);
    expect(isServerEnvironment('ssr', { consumer: 'client' })).toBe(true);
    expect(isServerEnvironment('client', { consumer: 'client' })).toBe(false);
    expect(isServerEnvironment(undefined, undefined)).toBe(false);
  });
});

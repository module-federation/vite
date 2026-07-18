import { describe, expect, it } from 'vitest';
import type { UserConfig } from 'vite';
import pluginExternalRuntimeCore, {
  EXTERNAL_RUNTIME_CORE_VIRTUAL_ID,
  RUNTIME_CORE_PACKAGE,
  buildExternalRuntimeCoreShimCode,
  collectRuntimeCoreExportNames,
  isSsrRemoteRuntimeImporter,
} from '../pluginExternalRuntimeCore';

function getHookFn<T>(hook: T | { handler: T } | undefined): T {
  if (!hook) throw new Error('hook missing');
  return typeof hook === 'function' ? hook : (hook as { handler: T }).handler;
}

describe('pluginExternalRuntimeCore', () => {
  it('collects named export keys excluding default', () => {
    expect(
      collectRuntimeCoreExportNames({
        default: {},
        ModuleFederation: class {},
        __esModule: true,
        init: () => {},
      })
    ).toEqual(['ModuleFederation', 'init']);
  });

  it('builds a shim that reads the host global and re-exports names', () => {
    const code = buildExternalRuntimeCoreShimCode(['ModuleFederation', 'init']);
    expect(code).toContain('globalThis._FEDERATION_RUNTIME_CORE');
    expect(code).toContain('experiments.externalRuntime is enabled');
    expect(code).toContain('export const ModuleFederation = mod["ModuleFederation"];');
    expect(code).toContain('export const init = mod["init"];');
    expect(code).toContain('export default mod.default ?? mod;');
  });

  it('resolves @module-federation/runtime-core to the virtual shim id', () => {
    const plugin = pluginExternalRuntimeCore();
    const resolve = getHookFn(plugin.resolveId);
    expect(
      (resolve as Function).call({}, RUNTIME_CORE_PACKAGE, undefined, { isEntry: false })
    ).toBe(EXTERNAL_RUNTIME_CORE_VIRTUAL_ID);
    expect(
      (resolve as Function).call({}, `${RUNTIME_CORE_PACKAGE}/`, undefined, { isEntry: false })
    ).toBe(EXTERNAL_RUNTIME_CORE_VIRTUAL_ID);
    expect(
      (resolve as Function).call({}, RUNTIME_CORE_PACKAGE, '/app/src/App.tsx', { isEntry: false })
    ).toBe(EXTERNAL_RUNTIME_CORE_VIRTUAL_ID);
    expect((resolve as Function).call({}, 'react', undefined, { isEntry: false })).toBeUndefined();
  });

  it('skips the browser shim for SSR remote importers', () => {
    const plugin = pluginExternalRuntimeCore();
    const resolve = getHookFn(plugin.resolveId);
    expect(isSsrRemoteRuntimeImporter('virtual:mf-REMOTE_ENTRY_SSR_ID:some_key')).toBe(true);
    expect(isSsrRemoteRuntimeImporter('virtual:mf-exposes-ssr:some_key')).toBe(true);
    expect(isSsrRemoteRuntimeImporter('/app/__mf_ssr__/entry.js')).toBe(true);
    expect(isSsrRemoteRuntimeImporter('/app/src/App.tsx')).toBe(false);
    expect(isSsrRemoteRuntimeImporter(undefined)).toBe(false);
    expect(
      (resolve as Function).call(
        {},
        RUNTIME_CORE_PACKAGE,
        'virtual:mf-REMOTE_ENTRY_SSR_ID:some_key',
        { isEntry: false }
      )
    ).toBeUndefined();
    expect(
      (resolve as Function).call({}, RUNTIME_CORE_PACKAGE, 'virtual:mf-exposes-ssr:some_key', {
        isEntry: false,
      })
    ).toBeUndefined();
    expect(
      (resolve as Function).call({}, RUNTIME_CORE_PACKAGE, '/app/__mf_ssr__/entry.js', {
        isEntry: false,
      })
    ).toBeUndefined();
  });

  it('excludes runtime-core from optimizeDeps', () => {
    const plugin = pluginExternalRuntimeCore();
    const config: UserConfig = {
      optimizeDeps: {
        include: [RUNTIME_CORE_PACKAGE, 'react'],
        exclude: [],
      },
    };
    const configHook = getHookFn(plugin.config);
    (configHook as Function).call({}, config, { command: 'serve', mode: 'development' });
    expect(config.optimizeDeps?.exclude).toContain(RUNTIME_CORE_PACKAGE);
    expect(config.optimizeDeps?.include).not.toContain(RUNTIME_CORE_PACKAGE);
    expect(config.optimizeDeps?.include).toContain('react');
  });

  it('loads shim code for the virtual id', async () => {
    const plugin = pluginExternalRuntimeCore();
    const loadHook = getHookFn(plugin.load);
    const code = await (loadHook as Function).call({}, EXTERNAL_RUNTIME_CORE_VIRTUAL_ID);
    expect(typeof code).toBe('string');
    expect(code).toContain('globalThis._FEDERATION_RUNTIME_CORE');
    expect(code).toMatch(/export const ModuleFederation/);
  });
});

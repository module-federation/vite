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

  it('builds a lazy shim that defers reading the host global until export access', () => {
    const code = buildExternalRuntimeCoreShimCode(['ModuleFederation', 'init']);
    expect(code).toContain('globalThis._FEDERATION_RUNTIME_CORE');
    expect(code).toContain('experiments.externalRuntime is enabled');
    expect(code).toContain('__mfCreateLazyRuntimeCoreExport');
    expect(code).toContain(
      'export const ModuleFederation = /*#__PURE__*/ __mfCreateLazyRuntimeCoreExport("ModuleFederation");'
    );
    expect(code).toContain(
      'export const init = /*#__PURE__*/ __mfCreateLazyRuntimeCoreExport("init");'
    );
    // Must not eagerly read/throw at module evaluation time (Vite dev ordering).
    expect(code).not.toMatch(/^const mod = globalThis\._FEDERATION_RUNTIME_CORE;/m);
    expect(code).not.toContain('export const ModuleFederation = mod["ModuleFederation"]');
  });

  it('allows evaluating the shim before the host global is published', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { pathToFileURL } = await import('node:url');

    const code = buildExternalRuntimeCoreShimCode(['ModuleFederation', 'satisfy']);
    const globalRef = globalThis as typeof globalThis & {
      _FEDERATION_RUNTIME_CORE?: Record<string, unknown>;
    };
    const previous = globalRef._FEDERATION_RUNTIME_CORE;
    delete globalRef._FEDERATION_RUNTIME_CORE;

    const dir = await mkdtemp(join(tmpdir(), 'mf-external-runtime-'));
    const file = join(dir, `shim-${Date.now()}.mjs`);
    await writeFile(file, code, 'utf8');

    try {
      const ns = await import(pathToFileURL(file).href);
      // Binding is created at evaluate time; property access is what requires the global.
      const binding = ns.ModuleFederation as object;
      expect(typeof binding).toBe('function');
      expect(() => Reflect.get(binding, 'name')).toThrow(/_FEDERATION_RUNTIME_CORE is missing/);

      function ModuleFederation(this: { ok: boolean }) {
        this.ok = true;
      }
      const satisfy = (a: string, b: string) => a === b;
      globalRef._FEDERATION_RUNTIME_CORE = { ModuleFederation, satisfy };

      expect((ns.satisfy as (a: string, b: string) => boolean)('1.0.0', '1.0.0')).toBe(true);
      const instance = new (ns.ModuleFederation as new () => { ok: boolean })();
      expect(instance.ok).toBe(true);
      expect(instance instanceof (ns.ModuleFederation as new () => unknown)).toBe(true);
    } finally {
      if (previous) globalRef._FEDERATION_RUNTIME_CORE = previous;
      else delete globalRef._FEDERATION_RUNTIME_CORE;
      await rm(dir, { recursive: true, force: true });
    }
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

import { afterEach, describe, expect, it } from 'vitest';
import * as runtimeCore from '@module-federation/runtime/core';
import injectExternalRuntimeCorePlugin from '../injectExternalRuntimeCorePlugin';

type FederationGlobal = typeof globalThis & {
  _FEDERATION_RUNTIME_CORE?: unknown;
  _FEDERATION_RUNTIME_CORE_FROM?: { name: string; version: string };
};

const globalRef = globalThis as FederationGlobal;
const previousCore = globalRef._FEDERATION_RUNTIME_CORE;
const previousFrom = globalRef._FEDERATION_RUNTIME_CORE_FROM;

afterEach(() => {
  if (previousCore === undefined) delete globalRef._FEDERATION_RUNTIME_CORE;
  else globalRef._FEDERATION_RUNTIME_CORE = previousCore;
  if (previousFrom === undefined) delete globalRef._FEDERATION_RUNTIME_CORE_FROM;
  else globalRef._FEDERATION_RUNTIME_CORE_FROM = previousFrom;
});

describe('injectExternalRuntimeCorePlugin', () => {
  it('publishes runtime-core on module evaluation so Vite remotes can resolve early', () => {
    // Importing this test file already evaluated the plugin module. Re-assert the
    // side effect contract: after load, the host global is populated.
    expect(globalRef._FEDERATION_RUNTIME_CORE).toBe(runtimeCore);
  });

  it('updates provider metadata in beforeInit', () => {
    delete globalRef._FEDERATION_RUNTIME_CORE_FROM;
    const plugin = injectExternalRuntimeCorePlugin();
    plugin.beforeInit({ options: { name: 'hostApp' } });
    expect(globalRef._FEDERATION_RUNTIME_CORE).toBe(runtimeCore);
    expect(globalRef._FEDERATION_RUNTIME_CORE_FROM).toEqual({
      version: '2.8.0',
      name: 'hostApp',
    });
  });
});

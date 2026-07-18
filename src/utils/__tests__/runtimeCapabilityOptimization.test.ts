import { describe, expect, it, vi } from 'vitest';
import {
  type ModuleFederationOptions,
  normalizeModuleFederationOptions,
} from '../normalizeModuleFederationOptions';
import {
  applyRuntimeCapabilityDefines,
  getRuntimeCapabilityConfigurationWarnings,
} from '../runtimeCapabilityOptimization';

function normalizeOptions(overrides: Partial<ModuleFederationOptions> = {}) {
  return normalizeModuleFederationOptions({
    name: 'host',
    ...overrides,
  });
}

describe('runtime capability optimization', () => {
  it('maps explicitly configured capabilities to runtime defines', () => {
    const define = {};
    const options = normalizeOptions({
      disableRemote: true,
      disableShared: false,
      disableSnapshot: true,
    });

    applyRuntimeCapabilityDefines(define, options);

    expect(define).toEqual({
      FEDERATION_OPTIMIZE_NO_REMOTE: 'true',
      FEDERATION_OPTIMIZE_NO_SHARED: 'false',
      FEDERATION_OPTIMIZE_NO_SNAPSHOT_PLUGIN: 'true',
    });
  });

  it('applies the environment snapshot default without enabling other defaults', () => {
    const define = {};

    applyRuntimeCapabilityDefines(define, normalizeOptions(), {
      defaultDisableSnapshot: true,
    });

    expect(define).toEqual({
      FEDERATION_OPTIMIZE_NO_SNAPSHOT_PLUGIN: 'true',
    });
  });

  it('allows an explicit snapshot option to override the environment default', () => {
    const define = {};

    applyRuntimeCapabilityDefines(define, normalizeOptions({ disableSnapshot: false }), {
      defaultDisableSnapshot: true,
    });

    expect(define).toEqual({
      FEDERATION_OPTIMIZE_NO_SNAPSHOT_PLUGIN: 'false',
    });
  });

  it('preserves existing defines and reports only conflicting explicit options', () => {
    const onConflict = vi.fn();
    const define = {
      FEDERATION_OPTIMIZE_NO_REMOTE: 'false',
      FEDERATION_OPTIMIZE_NO_SHARED: true,
      FEDERATION_OPTIMIZE_NO_SNAPSHOT_PLUGIN: 'false',
    };

    applyRuntimeCapabilityDefines(
      define,
      normalizeOptions({
        disableRemote: true,
        disableShared: true,
      }),
      {
        defaultDisableSnapshot: true,
        onConflict,
      }
    );

    expect(define).toEqual({
      FEDERATION_OPTIMIZE_NO_REMOTE: 'false',
      FEDERATION_OPTIMIZE_NO_SHARED: true,
      FEDERATION_OPTIMIZE_NO_SNAPSHOT_PLUGIN: 'false',
    });
    expect(onConflict).toHaveBeenCalledTimes(1);
    expect(onConflict).toHaveBeenCalledWith(
      expect.stringContaining('FEDERATION_OPTIMIZE_NO_REMOTE define')
    );
  });

  it('reports incompatible remote and shared configurations', () => {
    const warnings = getRuntimeCapabilityConfigurationWarnings(
      normalizeOptions({
        disableRemote: true,
        disableShared: true,
        remotes: {
          remoteApp: {
            name: 'remoteApp',
            entry: 'https://example.com/remoteEntry.js',
          },
        },
        shared: {
          react: {},
        },
      })
    );

    expect(warnings).toEqual([
      expect.stringContaining('disableRemote is true, but remotes are configured'),
      expect.stringContaining('disableShared is true, but shared dependencies are configured'),
    ]);
  });
});

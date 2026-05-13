import type { ViteDevServer } from 'vite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeModuleFederationOptions } from '../../../utils/normalizeModuleFederationOptions';
import type { AdapterContext } from '../../pluginDevRemoteHmr';
import { vueAdapter } from '../vue';

const { mfWarn } = vi.hoisted(() => ({
  mfWarn: vi.fn(),
}));

vi.mock('../../../utils/logger', () => ({
  mfWarn,
}));

function makeCtx(
  shared: Record<string, { singleton?: boolean } | string> | undefined
): AdapterContext {
  return {
    server: {} as ViteDevServer,
    options: normalizeModuleFederationOptions({
      name: 'remote-app',
      exposes: { './Button': { import: './src/Button.vue' } },
      remotes: {},
      shared,
      virtualModuleDir: '__mf__virtual',
    }),
    strategy: 'native',
  };
}

describe('vueAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('declares the Vue-specific plugin names', () => {
    expect(vueAdapter.pluginNames).toEqual(expect.arrayContaining(['vite:vue', 'vite:vue-jsx']));
  });

  it('warns when "vue" is not in shared', () => {
    vueAdapter.validate?.(makeCtx({}));
    expect(mfWarn).toHaveBeenCalledWith(
      expect.stringContaining('"vue" is not configured as a singleton')
    );
  });

  it('warns when "vue" is shared but singleton is false', () => {
    vueAdapter.validate?.(makeCtx({ vue: { singleton: false } }));
    expect(mfWarn).toHaveBeenCalledWith(
      expect.stringContaining('"vue" is not configured as a singleton')
    );
  });

  it('does not warn when "vue" is a singleton', () => {
    vueAdapter.validate?.(makeCtx({ vue: { singleton: true } }));
    expect(mfWarn).not.toHaveBeenCalled();
  });

  it('accepts @vue/runtime-core as the singleton', () => {
    vueAdapter.validate?.(makeCtx({ '@vue/runtime-core': { singleton: true } }));
    expect(mfWarn).not.toHaveBeenCalled();
  });

  it('accepts @vue/runtime-dom as the singleton', () => {
    vueAdapter.validate?.(makeCtx({ '@vue/runtime-dom': { singleton: true } }));
    expect(mfWarn).not.toHaveBeenCalled();
  });

  it('does not register a configureRemote hook', () => {
    expect(vueAdapter.configureRemote).toBeUndefined();
  });
});

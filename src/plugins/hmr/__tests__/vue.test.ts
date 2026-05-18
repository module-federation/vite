import type { ViteDevServer } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { normalizeModuleFederationOptions } from '../../../utils/normalizeModuleFederationOptions';
import type { AdapterContext } from '../../pluginDevRemoteHmr';
import { vueAdapter } from '../vue';

const { mfWarn } = vi.hoisted(() => ({
  mfWarn: vi.fn(),
}));

vi.mock('../../../utils/logger', () => ({
  mfWarn,
}));

function makeCtx(): AdapterContext {
  return {
    server: {} as ViteDevServer,
    options: normalizeModuleFederationOptions({
      name: 'host-app',
      exposes: {},
      remotes: { remoteApp: 'remoteApp@http://remote.example/remoteEntry.js' },
      virtualModuleDir: '__mf__virtual',
    }),
  };
}

function makeTransformCtx(federationName = 'host-app') {
  return {
    options: normalizeModuleFederationOptions({
      name: federationName,
      exposes: { './Foo': { import: './src/Foo.vue' } },
      remotes: {},
      virtualModuleDir: '__mf__virtual',
    }),
  };
}

describe('vueAdapter', () => {
  it('declares the Vue-specific plugin names', () => {
    expect(vueAdapter.pluginNames).toEqual(expect.arrayContaining(['vite:vue', 'vite:vue-jsx']));
  });

  it('does not register a remote configureServer hook', () => {
    expect(vueAdapter.remote?.configureServer).toBeUndefined();
  });

  it('emits a __VUE_HMR_RUNTIME__ guard script injected at head-prepend', () => {
    const tags = vueAdapter.host?.transformIndexHtml?.(makeCtx()) ?? [];

    expect(tags).toHaveLength(1);
    const [tag] = tags;
    expect(tag.tag).toBe('script');
    expect(tag.injectTo).toBe('head-prepend');
    // Non-module script: must run before Vue's deps module loads.
    expect(tag.attrs?.type).toBeUndefined();
    expect(typeof tag.children).toBe('string');
    expect(tag.children).toContain('__VUE_HMR_RUNTIME__');
    expect(tag.children).toContain('Object.defineProperty');
  });

  it('guard uses a first-write-wins setter that drops later writes', () => {
    const [tag] = vueAdapter.host?.transformIndexHtml?.(makeCtx()) ?? [];
    const code = typeof tag.children === 'string' ? tag.children : '';

    // Execute the guard in an isolated scope and verify the trap.
    const sandbox: { __VUE_HMR_RUNTIME__?: unknown } = {};
    new Function('globalThis', code)(sandbox);

    sandbox.__VUE_HMR_RUNTIME__ = { id: 'host' };
    sandbox.__VUE_HMR_RUNTIME__ = { id: 'remote-overwrite' };

    expect(sandbox.__VUE_HMR_RUNTIME__).toEqual({ id: 'host' });
  });

  describe('transform', () => {
    const sfcModule = (hmrIdLiteral: string) =>
      [
        'const _sfc_main = {};',
        `_sfc_main.__hmrId = "${hmrIdLiteral}";`,
        '__VUE_HMR_RUNTIME__.createRecord(_sfc_main.__hmrId, _sfc_main);',
        'import.meta.hot.accept((updated) => {',
        '  __VUE_HMR_RUNTIME__.reload(updated.__hmrId, updated);',
        '});',
      ].join('\n');

    it('prefixes _sfc_main.__hmrId with the federation name', () => {
      const result = vueAdapter.remote?.transform?.(
        sfcModule('abc123'),
        '/Foo.vue',
        makeTransformCtx()
      );
      expect(result).toContain('_sfc_main.__hmrId = "host-app-abc123"');
      // createRecord/reload reference the literal indirectly via _sfc_main.__hmrId,
      // so only the literal line needs rewriting — the call sites stay untouched.
      expect(result).toContain('__VUE_HMR_RUNTIME__.createRecord(_sfc_main.__hmrId, _sfc_main);');
    });

    it('does not double-prefix already-prefixed hmrIds (idempotent re-runs)', () => {
      const result = vueAdapter.remote?.transform?.(
        sfcModule('host-app-abc123'),
        '/Foo.vue',
        makeTransformCtx()
      );
      // Already prefixed → no change → adapter returns undefined.
      expect(result).toBeUndefined();
    });

    it('returns undefined for code without __VUE_HMR_RUNTIME__.createRecord', () => {
      const code = 'export const x = 1;\n_sfc_main.__hmrId = "abc123";';
      const result = vueAdapter.remote?.transform?.(code, '/some.ts', makeTransformCtx());
      expect(result).toBeUndefined();
    });

    it('warns once when createRecord is present but no __hmrId literal can be rewritten', () => {
      mfWarn.mockClear();
      // Simulates a future @vitejs/plugin-vue output shape that the regex no
      // longer matches — guards against silent regressions.
      const code = [
        'const _sfc_main = {};',
        // Hypothetical future shape: defineProperty instead of literal assignment.
        'Object.defineProperty(_sfc_main, "__hmrId", { value: "abc123" });',
        '__VUE_HMR_RUNTIME__.createRecord(_sfc_main.__hmrId, _sfc_main);',
      ].join('\n');

      const first = vueAdapter.remote?.transform?.(code, '/Foo.vue', makeTransformCtx());
      const second = vueAdapter.remote?.transform?.(code, '/Bar.vue', makeTransformCtx());

      expect(first).toBeUndefined();
      expect(second).toBeUndefined();
      expect(mfWarn).toHaveBeenCalledTimes(1);
      expect(mfWarn).toHaveBeenCalledWith(
        expect.stringContaining('@vitejs/plugin-vue may have changed')
      );
    });
  });
});

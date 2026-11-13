import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { sharedCacheHelperCode } from '../packageUtils';
import { getRuntimeInitResolveBootstrapCode } from '../../virtualModules/virtualRuntimeInitStatus';
import ssrEntryLoaderPlugin, { revalidate } from '../ssrEntryLoader';

const { evaluation } = vi.hoisted(() => ({ evaluation: { source: '', cache: {} as any } }));
vi.mock('../ssrVmStrategy', () => ({
  isVmStrategyAvailable: async () => true,
  loadViaVmStrategy: () => Function('cache', evaluation.source)(evaluation.cache),
  clearVmStrategyCaches: () => {},
}));

describe('SSR loader graph index', () => {
  it.skipIf(!global.gc)(
    'does not own a reset graph when the host stays alive without another load',
    async () => {
      evaluation.cache = {};
      evaluation.source = `${sharedCacheHelperCode}
      ${getRuntimeInitResolveBootstrapCode(false, 'reset-graph-index')}
      __mfSubscribeSharedCache(cache, { canonical: 'default:reset', aliases: [] }, () => {});
      return { init: () => initResolve({}), get: async () => () => ({ default: () => 'loaded' }) };
    `;
      const origin = {};
      const url = 'http://localhost:5999/remoteEntry.ssr.js';
      const plugin = ssrEntryLoaderPlugin({ strategy: 'vm' });
      const load = async () => {
        const container = await plugin.loadEntry({
          remoteInfo: { name: 'reset-graph-index', entry: url },
          origin,
        });
        const factory = await (container as any).get('./Widget');
        expect(factory().default()).toBe('loaded');
      };
      await load();
      expect(
        evaluation.cache[Symbol.for('module-federation.shared-cache-listeners')]['default:reset']
          .size
      ).toBe(1);
      revalidate(url);
      for (let index = 0; index < 6; index++) {
        await setImmediate();
        global.gc!({ type: 'major', execution: 'sync' });
        await setImmediate();
      }
      expect(
        evaluation.cache[Symbol.for('module-federation.shared-cache-listeners')]['default:reset']
          .size
      ).toBe(0);
      expect(origin).toEqual({});
    }
  );
});

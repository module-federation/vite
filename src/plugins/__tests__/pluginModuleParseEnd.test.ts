import { describe, expect, it } from 'vitest';
import pluginModuleParseEnd, { parsePromise } from '../pluginModuleParseEnd';
import { callHook } from '../../utils/__tests__/viteHookHelpers';

function getParsePlugins(excludeFn: (id: string) => boolean) {
  const plugins = pluginModuleParseEnd(excludeFn, {
    moduleParseTimeout: 10,
    virtualExposesId: 'virtual:mf:exposes',
  });

  const parseStart = plugins.find((plugin) => plugin.name === 'parseStart');
  const parseEnd = plugins.find((plugin) => plugin.name === 'parseEnd');
  if (!parseStart || !parseEnd) throw new Error('parse plugins not found');
  return { parseStart, parseEnd };
}

async function resolvesQuickly(promise: Promise<unknown>) {
  return Promise.race([
    promise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 25)),
  ]);
}

describe('pluginModuleParseEnd', () => {
  it('resolves parsePromise on buildEnd', async () => {
    const { parseStart, parseEnd } = getParsePlugins(() => false);
    const ctx = {} as any;

    callHook(parseStart.buildStart, ctx, undefined as never);
    callHook(parseStart.load, ctx, '/src/main.ts');
    callHook(parseEnd.buildEnd, ctx);

    expect(await resolvesQuickly(parsePromise)).toBe(true);
  });

  it('does not wait for excluded load-share or prebuild ids', async () => {
    const { parseStart, parseEnd } = getParsePlugins(
      (id) => id.includes('__loadShare__') || id.includes('__prebuild__')
    );
    const ctx = {} as any;

    callHook(parseStart.buildStart, ctx, undefined as never);
    callHook(parseStart.load, ctx, 'virtual:mf:app__loadShare__react__loadShare__.js');
    callHook(parseStart.load, ctx, 'virtual:mf:app__prebuild__react__prebuild__.js');
    callHook(parseStart.load, ctx, '/src/main.ts');

    callHook(parseEnd.moduleParsed, ctx, { id: '/src/main.ts' } as never);

    expect(await resolvesQuickly(parsePromise)).toBe(true);
  });
});

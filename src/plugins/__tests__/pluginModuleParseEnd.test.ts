import { describe, expect, it, vi } from 'vitest';
import { build as viteBuild } from 'vite';
import pluginModuleParseEnd, { createModuleParseController } from '../pluginModuleParseEnd';
import { callHook } from '../../utils/__tests__/viteHookHelpers';

function getParsePlugins(
  excludeFn: (id: string) => boolean,
  exposedModuleImports?: string[],
  moduleParseIdleTimeout?: number
) {
  const controller = createModuleParseController();
  const plugins = pluginModuleParseEnd(
    excludeFn,
    {
      moduleParseTimeout: 10,
      moduleParseIdleTimeout,
      exposedModuleImports,
    },
    controller
  );

  const parseStart = plugins.find((plugin) => plugin.name === 'parseStart');
  const parseEnd = plugins.find((plugin) => plugin.name === 'parseEnd');
  if (!parseStart || !parseEnd) throw new Error('parse plugins not found');
  return { controller, parseStart, parseEnd };
}

async function resolvesQuickly(promise: Promise<unknown>, timeout = 25) {
  return Promise.race([
    promise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeout)),
  ]);
}

describe('pluginModuleParseEnd', () => {
  it('resolves parsePromise on buildEnd', async () => {
    const { controller, parseStart, parseEnd } = getParsePlugins(() => false);
    const ctx = {} as any;

    callHook(parseStart.buildStart, ctx, undefined as never);
    callHook(parseStart.load, ctx, '/src/main.ts');
    callHook(parseEnd.buildEnd, ctx);

    expect(await controller.parsePromise).toEqual({ complete: false, reason: 'build-end' });
  });

  it('marks an idle-timeout barrier result as incomplete', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { controller, parseStart } = getParsePlugins(() => false, undefined, 0.001);

      callHook(parseStart.buildStart, {} as any, undefined as never);

      expect(await controller.parsePromise).toEqual({
        complete: false,
        reason: 'idle-timeout',
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not wait for excluded load-share or prebuild ids', async () => {
    const { controller, parseStart, parseEnd } = getParsePlugins(
      (id) => id.includes('__loadShare__') || id.includes('__prebuild__')
    );
    const ctx = {} as any;

    callHook(parseStart.buildStart, ctx, undefined as never);
    callHook(parseStart.load, ctx, 'virtual:mf:app__loadShare__react__loadShare__.js');
    callHook(parseStart.load, ctx, 'virtual:mf:app__prebuild__react__prebuild__.js');
    callHook(parseStart.load, ctx, '/src/main.ts');

    callHook(parseEnd.moduleParsed, ctx, { id: '/src/main.ts' } as never);

    expect(await resolvesQuickly(controller.parsePromise)).toBe(true);
  });

  it('settles when an excluded barrier module loads after the graph completes', async () => {
    const { controller, parseStart, parseEnd } = getParsePlugins((id) =>
      id.includes('__loadShare__')
    );
    const ctx = {} as any;

    callHook(parseStart.buildStart, ctx, undefined as never);
    callHook(parseStart.load, ctx, '/src/main.ts');
    callHook(parseEnd.moduleParsed, ctx, { id: '/src/main.ts' } as never);
    callHook(parseStart.load, ctx, 'virtual:mf:app__loadShare__react__loadShare__.js');

    expect(await resolvesQuickly(controller.parsePromise)).toBe(true);
  });

  it('does not settle an empty graph just because an excluded module loads', async () => {
    const { controller, parseStart } = getParsePlugins((id) => id.includes('__loadShare__'));
    const ctx = {} as any;

    callHook(parseStart.buildStart, ctx, undefined as never);
    callHook(parseStart.load, ctx, 'virtual:mf:app__loadShare__react__loadShare__.js');

    expect(await resolvesQuickly(controller.parsePromise)).toBe(false);
  });

  it('settles when parsed modules are a superset of tracked loads', async () => {
    const { controller, parseStart, parseEnd } = getParsePlugins(() => false);
    const ctx = {} as any;

    callHook(parseStart.buildStart, ctx, undefined as never);
    callHook(parseStart.load, ctx, '/src/main.ts');
    callHook(parseEnd.moduleParsed, ctx, { id: '/virtual/internal.ts' } as never);
    callHook(parseEnd.moduleParsed, ctx, { id: '/src/main.ts' } as never);

    expect(await controller.parsePromise).toEqual({
      complete: true,
      reason: 'graph-complete',
    });
  });

  it('waits for imported children discovered when an entry is parsed', async () => {
    const { controller, parseStart, parseEnd } = getParsePlugins(() => false);
    const ctx = { getModuleInfo: () => undefined } as any;

    callHook(parseStart.buildStart, ctx, undefined as never);
    callHook(parseStart.load, ctx, '/src/main.ts');
    callHook(parseEnd.moduleParsed, ctx, {
      id: '/src/main.ts',
      importedIds: ['/src/child.ts'],
      dynamicallyImportedIds: [],
      importedIdResolutions: [{ id: '/src/child.ts', external: false }],
      dynamicallyImportedIdResolutions: [],
    } as never);
    callHook(parseStart.load, ctx, '/src/child.ts');
    expect(await resolvesQuickly(controller.parsePromise)).toBe(false);

    callHook(parseEnd.moduleParsed, ctx, {
      id: '/src/child.ts',
      importedIds: [],
      dynamicallyImportedIds: [],
      importedIdResolutions: [],
      dynamicallyImportedIdResolutions: [],
    } as never);

    expect(await resolvesQuickly(controller.parsePromise)).toBe(true);
  });

  it('tracks resolved imported ids when resolution metadata is unavailable', async () => {
    const { controller, parseStart, parseEnd } = getParsePlugins(() => false);
    const ctx = {
      getModuleInfo: () => ({ isExternal: false }),
    } as any;

    callHook(parseStart.buildStart, ctx, undefined as never);
    callHook(parseStart.load, ctx, '/src/main.ts');
    callHook(parseEnd.moduleParsed, ctx, {
      id: '/src/main.ts',
      importedIds: ['/src/late-child.ts'],
      dynamicallyImportedIds: [],
    } as never);

    expect(await resolvesQuickly(controller.parsePromise)).toBe(false);

    callHook(parseStart.load, ctx, '/src/late-child.ts');
    callHook(parseEnd.moduleParsed, ctx, {
      id: '/src/late-child.ts',
      importedIds: [],
      dynamicallyImportedIds: [],
    } as never);

    expect(await controller.parsePromise).toEqual({
      complete: true,
      reason: 'graph-complete',
    });
  });

  it('does not wait for external dependencies discovered during parsing', async () => {
    const { controller, parseStart, parseEnd } = getParsePlugins(() => false);
    const ctx = {} as any;

    callHook(parseStart.buildStart, ctx, undefined as never);
    callHook(parseStart.load, ctx, '/src/main.ts');
    callHook(parseEnd.moduleParsed, ctx, {
      id: '/src/main.ts',
      importedIds: ['external-package'],
      dynamicallyImportedIds: [],
      importedIdResolutions: [{ id: 'external-package', external: true }],
      dynamicallyImportedIdResolutions: [],
    } as never);

    expect(await resolvesQuickly(controller.parsePromise)).toBe(true);
  });

  it('completes when the only pending ids are externals reported with a ModuleInfo stub', async () => {
    // Rolldown returns a ModuleInfo for external ids without an `isExternal`
    // marker, so the id has to be resolved again to find out.
    const { controller, parseStart, parseEnd } = getParsePlugins(() => false);
    const ctx = {
      getModuleInfo: () => ({ id: 'react', code: null }),
      resolve: async () => ({ id: 'react', external: true }),
    } as any;

    callHook(parseStart.buildStart, ctx, undefined as never);
    callHook(parseStart.load, ctx, '/src/main.ts');
    callHook(parseEnd.moduleParsed, ctx, {
      id: '/src/main.ts',
      importedIds: ['react'],
      dynamicallyImportedIds: [],
    } as never);

    expect(await controller.parsePromise).toEqual({
      complete: true,
      reason: 'graph-complete',
    });
  });

  it('filters configured externals that bypass resolveId hooks', async () => {
    const { controller, parseStart, parseEnd } = getParsePlugins(() => false);
    const ctx = { getModuleInfo: () => ({ id: 'react', code: null }) } as any;

    callHook(parseStart.configResolved, ctx, {
      build: { rollupOptions: { external: [/^react$/] } },
    } as never);
    callHook(parseStart.buildStart, ctx, undefined as never);
    callHook(parseStart.load, ctx, '/src/main.ts');
    callHook(parseEnd.moduleParsed, ctx, {
      id: '/src/main.ts',
      importedIds: ['react'],
      dynamicallyImportedIds: [],
    } as never);

    expect(await controller.parsePromise).toEqual({
      complete: true,
      reason: 'graph-complete',
    });
  });

  it('keeps waiting for an internal id after slow resolution', async () => {
    const { controller, parseStart, parseEnd } = getParsePlugins(() => false);
    const ctx = {
      getModuleInfo: () => ({ id: '/src/late-child.ts', code: null }),
      resolve: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { id: '/src/late-child.ts', external: false };
      },
    } as any;

    callHook(parseStart.buildStart, ctx, undefined as never);
    callHook(parseStart.load, ctx, '/src/main.ts');
    callHook(parseEnd.moduleParsed, ctx, {
      id: '/src/main.ts',
      importedIds: ['/src/late-child.ts'],
      dynamicallyImportedIds: [],
    } as never);

    callHook(parseStart.load, ctx, '/src/late-child.ts');

    expect(await resolvesQuickly(controller.parsePromise)).toBe(false);

    callHook(parseEnd.moduleParsed, ctx, {
      id: '/src/late-child.ts',
      importedIds: [],
      dynamicallyImportedIds: [],
    } as never);

    expect(await controller.parsePromise).toEqual({
      complete: true,
      reason: 'graph-complete',
    });
  });

  it('tracks children of the excluded virtual exposes module', async () => {
    const virtualExposesId = 'virtual:mf:exposes';
    const { controller, parseStart, parseEnd } = getParsePlugins((id) =>
      id.includes(virtualExposesId)
    );
    const ctx = {} as any;

    callHook(parseStart.buildStart, ctx, undefined as never);
    callHook(parseStart.load, ctx, virtualExposesId);
    callHook(parseEnd.moduleParsed, ctx, {
      id: `\0${virtualExposesId}`,
      importedIds: [],
      dynamicallyImportedIds: ['/src/expose-a.ts', '/src/expose-b.ts'],
      importedIdResolutions: [],
      dynamicallyImportedIdResolutions: [
        { id: '/src/expose-a.ts', external: false },
        { id: '/src/expose-b.ts', external: false },
      ],
    } as never);
    for (const id of ['/src/expose-a.ts', '/src/expose-b.ts']) {
      callHook(parseStart.load, ctx, id);
    }
    expect(await resolvesQuickly(controller.parsePromise)).toBe(false);

    for (const id of ['/src/expose-a.ts', '/src/expose-b.ts']) {
      callHook(parseEnd.moduleParsed, ctx, {
        id,
        importedIds: [],
        dynamicallyImportedIds: [],
        importedIdResolutions: [],
        dynamicallyImportedIdResolutions: [],
      } as never);
    }

    expect(await resolvesQuickly(controller.parsePromise)).toBe(true);
  });

  it('waits for configured expose entries even before Rollup loads them', async () => {
    const childId = '/src/expose.ts';
    const { controller, parseStart, parseEnd } = getParsePlugins(() => false, ['./src/expose.ts']);
    const ctx = {
      resolve: async (id: string) => ({ id: id === './src/expose.ts' ? childId : id }),
    } as any;

    await callHook(parseStart.buildStart, ctx, undefined as never);
    expect(await resolvesQuickly(controller.parsePromise)).toBe(false);

    callHook(parseStart.load, ctx, childId);
    callHook(parseEnd.moduleParsed, ctx, {
      id: childId,
      importedIds: [],
      dynamicallyImportedIds: [],
      importedIdResolutions: [],
      dynamicallyImportedIdResolutions: [],
    } as never);

    expect(await resolvesQuickly(controller.parsePromise)).toBe(true);
  });

  it('isolates parse completion across plugin instances', async () => {
    const {
      controller: firstController,
      parseStart: firstStart,
      parseEnd: firstEnd,
    } = getParsePlugins(() => false);
    const {
      controller: secondController,
      parseStart: secondStart,
      parseEnd: secondEnd,
    } = getParsePlugins(() => false);
    const ctx = {} as any;

    await callHook(firstStart.buildStart, ctx, undefined as never);
    await callHook(secondStart.buildStart, ctx, undefined as never);
    callHook(firstStart.load, ctx, '/src/first.ts');
    callHook(firstEnd.moduleParsed, ctx, { id: '/src/first.ts' } as never);

    expect(await firstController.parsePromise).toEqual({
      complete: true,
      reason: 'graph-complete',
    });
    expect(await resolvesQuickly(secondController.parsePromise)).toBe(false);

    callHook(secondStart.load, ctx, '/src/second.ts');
    callHook(secondEnd.moduleParsed, ctx, { id: '/src/second.ts' } as never);
    expect(await secondController.parsePromise).toEqual({
      complete: true,
      reason: 'graph-complete',
    });
  });

  it.each(['rollupOptions', 'rolldownOptions'] as const)(
    'waits for configured %s inputs before they are loaded',
    async (inputOption) => {
      const { controller, parseStart, parseEnd } = getParsePlugins(() => false);
      const ctx = {
        resolve: async (id: string) => ({ id: `/resolved/${id}` }),
      } as any;

      const input = {
        first: 'src/first.ts',
        second: 'src/second.ts',
      };
      callHook(parseStart.configResolved, ctx, {
        build: {
          rollupOptions: inputOption === 'rollupOptions' ? { input } : {},
          ...(inputOption === 'rolldownOptions' ? { rolldownOptions: { input } } : {}),
        },
      } as never);
      await callHook(parseStart.buildStart, ctx, undefined as never);

      callHook(parseStart.load, ctx, '/resolved/src/first.ts');
      callHook(parseEnd.moduleParsed, ctx, { id: '/resolved/src/first.ts' } as never);
      expect(await resolvesQuickly(controller.parsePromise)).toBe(false);

      callHook(parseStart.load, ctx, '/resolved/src/second.ts');
      callHook(parseEnd.moduleParsed, ctx, { id: '/resolved/src/second.ts' } as never);
      expect(await controller.parsePromise).toEqual({
        complete: true,
        reason: 'graph-complete',
      });
    }
  );

  it('resets parse state between consecutive builds', async () => {
    const { controller, parseStart, parseEnd } = getParsePlugins(() => false);
    const ctx = {} as any;

    await callHook(parseStart.buildStart, ctx, undefined as never);
    callHook(parseStart.load, ctx, '/src/first-build.ts');
    callHook(parseEnd.buildEnd, ctx);
    expect(await controller.parsePromise).toEqual({
      complete: false,
      reason: 'build-end',
    });

    await callHook(parseStart.buildStart, ctx, undefined as never);
    callHook(parseStart.load, ctx, '/src/second-build.ts');
    callHook(parseEnd.moduleParsed, ctx, {
      id: '/src/second-build.ts',
      importedIds: [],
      dynamicallyImportedIds: [],
      importedIdResolutions: [],
      dynamicallyImportedIdResolutions: [],
    } as never);

    expect(await controller.parsePromise).toEqual({
      complete: true,
      reason: 'graph-complete',
    });
  });

  it('waits for child transforms in a real Vite module graph without resolution metadata', async () => {
    const controller = createModuleParseController();
    const parsePlugins = pluginModuleParseEnd(
      () => false,
      {
        moduleParseTimeout: 0,
      },
      controller
    );
    let childTransformed = false;
    let resolvedBeforeChild = false;

    await viteBuild({
      configFile: false,
      logLevel: 'silent',
      plugins: [
        ...parsePlugins,
        {
          name: 'parse-barrier-vite-probe',
          buildStart() {
            void controller.parsePromise.then(() => {
              resolvedBeforeChild = !childTransformed;
            });
          },
          resolveId(id) {
            if (id === 'virtual:parse-entry' || id === 'virtual:parse-child') return `\0${id}`;
          },
          async load(id) {
            if (id === '\0virtual:parse-entry') {
              return 'import "virtual:parse-child"; export const entry = true;';
            }
            if (id === '\0virtual:parse-child') {
              await new Promise((resolve) => setTimeout(resolve, 5));
              return 'export const child = true;';
            }
          },
          transform(_code, id) {
            if (id === '\0virtual:parse-child') childTransformed = true;
          },
        },
      ],
      build: {
        write: false,
        minify: false,
        rollupOptions: { input: 'virtual:parse-entry' },
      },
    });
    await Promise.resolve();

    expect(childTransformed).toBe(true);
    expect(resolvedBeforeChild).toBe(false);
  });
});

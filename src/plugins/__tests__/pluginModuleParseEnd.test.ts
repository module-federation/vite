import { describe, expect, it } from 'vitest';
import { build as viteBuild } from 'vite';
import pluginModuleParseEnd, { parsePromise } from '../pluginModuleParseEnd';
import { callHook } from '../../utils/__tests__/viteHookHelpers';

function getParsePlugins(excludeFn: (id: string) => boolean, exposedModuleImports?: string[]) {
  const plugins = pluginModuleParseEnd(excludeFn, {
    moduleParseTimeout: 10,
    exposedModuleImports,
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

  it('settles when an excluded barrier module loads after the graph completes', async () => {
    const { parseStart, parseEnd } = getParsePlugins((id) => id.includes('__loadShare__'));
    const ctx = {} as any;

    callHook(parseStart.buildStart, ctx, undefined as never);
    callHook(parseStart.load, ctx, '/src/main.ts');
    callHook(parseEnd.moduleParsed, ctx, { id: '/src/main.ts' } as never);
    callHook(parseStart.load, ctx, 'virtual:mf:app__loadShare__react__loadShare__.js');

    expect(await resolvesQuickly(parsePromise)).toBe(true);
  });

  it('does not settle an empty graph just because an excluded module loads', async () => {
    const { parseStart } = getParsePlugins((id) => id.includes('__loadShare__'));
    const ctx = {} as any;

    callHook(parseStart.buildStart, ctx, undefined as never);
    callHook(parseStart.load, ctx, 'virtual:mf:app__loadShare__react__loadShare__.js');

    expect(await resolvesQuickly(parsePromise)).toBe(false);
  });

  it('settles when parsed modules are a superset of tracked loads', async () => {
    const { parseStart, parseEnd } = getParsePlugins(() => false);
    const ctx = {} as any;

    callHook(parseStart.buildStart, ctx, undefined as never);
    callHook(parseStart.load, ctx, '/src/main.ts');
    callHook(parseEnd.moduleParsed, ctx, { id: '/virtual/internal.ts' } as never);
    callHook(parseEnd.moduleParsed, ctx, { id: '/src/main.ts' } as never);

    expect(await resolvesQuickly(parsePromise)).toBe(true);
  });

  it('waits for imported children discovered when an entry is parsed', async () => {
    const { parseStart, parseEnd } = getParsePlugins(() => false);
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
    expect(await resolvesQuickly(parsePromise)).toBe(false);

    callHook(parseEnd.moduleParsed, ctx, {
      id: '/src/child.ts',
      importedIds: [],
      dynamicallyImportedIds: [],
      importedIdResolutions: [],
      dynamicallyImportedIdResolutions: [],
    } as never);

    expect(await resolvesQuickly(parsePromise)).toBe(true);
  });

  it('does not wait for external dependencies discovered during parsing', async () => {
    const { parseStart, parseEnd } = getParsePlugins(() => false);
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

    expect(await resolvesQuickly(parsePromise)).toBe(true);
  });

  it('tracks children of the excluded virtual exposes module', async () => {
    const virtualExposesId = 'virtual:mf:exposes';
    const { parseStart, parseEnd } = getParsePlugins((id) => id.includes(virtualExposesId));
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
    expect(await resolvesQuickly(parsePromise)).toBe(false);

    for (const id of ['/src/expose-a.ts', '/src/expose-b.ts']) {
      callHook(parseEnd.moduleParsed, ctx, {
        id,
        importedIds: [],
        dynamicallyImportedIds: [],
        importedIdResolutions: [],
        dynamicallyImportedIdResolutions: [],
      } as never);
    }

    expect(await resolvesQuickly(parsePromise)).toBe(true);
  });

  it('waits for configured expose entries even before Rollup loads them', async () => {
    const childId = '/src/expose.ts';
    const { parseStart, parseEnd } = getParsePlugins(() => false, ['./src/expose.ts']);
    const ctx = {
      resolve: async (id: string) => ({ id: id === './src/expose.ts' ? childId : id }),
    } as any;

    await callHook(parseStart.buildStart, ctx, undefined as never);
    expect(await resolvesQuickly(parsePromise)).toBe(false);

    callHook(parseStart.load, ctx, childId);
    callHook(parseEnd.moduleParsed, ctx, {
      id: childId,
      importedIds: [],
      dynamicallyImportedIds: [],
      importedIdResolutions: [],
      dynamicallyImportedIdResolutions: [],
    } as never);

    expect(await resolvesQuickly(parsePromise)).toBe(true);
  });

  it('waits for child transforms in a real Vite module graph without resolution metadata', async () => {
    const parsePlugins = pluginModuleParseEnd(() => false, {
      moduleParseTimeout: 0,
    });
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
            void parsePromise.then(() => {
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

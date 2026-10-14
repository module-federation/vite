import { describe, expect, it, vi } from 'vitest';
import {
  generateExposes,
  getExposesCssMapPlaceholder,
  getVirtualExposesId,
} from '../virtualExposes';
import { getDefaultMockOptions } from '../../utils/__tests__/helpers';

type AssetRequestContextRuntimeStub = {
  hasAssetRequestContext: () => boolean;
  loadCssWithAssetRequestContext: (href: string) => Promise<void> | undefined;
  registerProducerModule: (url: string) => void;
};

const noAssetRequestContext: AssetRequestContextRuntimeStub = {
  hasAssetRequestContext: () => false,
  loadCssWithAssetRequestContext: () => undefined,
  registerProducerModule: () => {},
};

function toRunnableModule(code: string, assetRequestContextRuntime = noAssetRequestContext) {
  const transformed = code
    .replace(
      /^\s*import \{ hasAssetRequestContext, loadCssWithAssetRequestContext, registerProducerModule \} from .*;$/m,
      ''
    )
    .replace('export default', 'return')
    .split('import.meta.url')
    .join('__importMetaUrl')
    .replace(/import\((".*?")\)/g, '__dynamicImport($1)');

  const factory = new Function(
    'document',
    'URL',
    '__dynamicImport',
    '__importMetaUrl',
    'hasAssetRequestContext',
    'loadCssWithAssetRequestContext',
    'registerProducerModule',
    `return (async () => {${transformed}\n})();`
  ) as (
    document: any,
    URLCtor: typeof URL,
    dynamicImport: (id: string) => Promise<unknown>,
    importMetaUrl: string,
    ...runtime: AssetRequestContextRuntimeStub[keyof AssetRequestContextRuntimeStub][]
  ) => Promise<Record<string, () => Promise<unknown>>>;

  return (
    document: any,
    URLCtor: typeof URL,
    dynamicImport: (id: string) => Promise<unknown>,
    importMetaUrl: string
  ) =>
    factory(
      document,
      URLCtor,
      dynamicImport,
      importMetaUrl,
      assetRequestContextRuntime.hasAssetRequestContext,
      assetRequestContextRuntime.loadCssWithAssetRequestContext,
      assetRequestContextRuntime.registerProducerModule
    );
}

async function flushMicrotasks() {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await Promise.resolve();
}

describe('virtualExposes', () => {
  it('scopes virtual id by name and filename and sanitizes invalid chars', () => {
    expect(
      getVirtualExposesId({
        internalName: '__mfe_internal__@scope/remote.app',
        filename: 'nested/remoteEntry.js?x=1',
      } as any)
    ).toBe('virtual:mf-exposes:__mfe_internal___scope_remote_app__nested_remoteEntry_js_x_1');
  });

  it('always emits the css placeholder and gates plain <link> injection on bundleAllCSS', () => {
    const noCssBundleCode = generateExposes(
      getDefaultMockOptions({
        exposes: {
          './Button': { import: './src/Button.ts' } as any,
        },
        bundleAllCSS: false as any,
      })
    );
    const cssBundleCode = generateExposes(
      getDefaultMockOptions({
        exposes: {
          './Button': { import: './src/Button.ts' } as any,
        },
        bundleAllCSS: true as any,
      })
    );

    for (const code of [noCssBundleCode, cssBundleCode]) {
      expect(code).toContain(`const cssAssetMap = "${getExposesCssMapPlaceholder()}";`);
    }
    expect(noCssBundleCode).toContain('const bundleAllCSS = false;');
    expect(cssBundleCode).toContain('const bundleAllCSS = true;');
  });

  it('adds a lazy browser hydration capability without changing the default export', async () => {
    const code = generateExposes(
      getDefaultMockOptions({
        exposes: { './Button': { import: './Button.tsx' } as any },
      }),
      {},
      'build',
      new Set(['./Button'])
    );
    const hydrateRoot = vi.fn(() => ({ hydrated: true }));
    const dynamicImport = vi.fn((id: string) => {
      if (id === './Button.tsx') return Promise.resolve({ default: 'Button' });
      if (id === 'react') return Promise.resolve({ createElement: vi.fn(() => 'element') });
      if (id === 'react-dom/client') return Promise.resolve({ hydrateRoot });
      return Promise.reject(new Error(`unexpected import: ${id}`));
    });
    const exposes = await toRunnableModule(code)(
      undefined,
      URL,
      dynamicImport,
      'file:///repo/remoteEntry.js'
    );
    const module = (await exposes['./Button']()) as any;

    expect(module.default).toBe('Button');
    expect(module.__mf_island.version).toBe(1);
    const root = {
      hasAttribute: () => true,
      getAttribute: () => encodeURIComponent(JSON.stringify({ fromServer: true })),
    };
    await module.__mf_island.hydrate(root, { fromClient: true });
    expect(hydrateRoot).toHaveBeenCalledWith(root, 'element');
    // The island adds no static imports; the only one is the assetRequestContext runtime.
    expect(code.match(/^\s*import\s.*$/gm)).toEqual([
      expect.stringContaining(
        'import { hasAssetRequestContext, loadCssWithAssetRequestContext, registerProducerModule }'
      ),
    ]);
  });

  it('injects css once and evaluates independent exposes concurrently', async () => {
    const code = generateExposes(
      getDefaultMockOptions({
        exposes: {
          './one': { import: './one.js' } as any,
          './two': { import: './two.js' } as any,
        },
        bundleAllCSS: true as any,
      })
    ).replace(
      `"${getExposesCssMapPlaceholder()}"`,
      JSON.stringify({
        './one': ['./style.css'],
        './two': ['./style.css'],
      })
    );

    const appendedHrefs: string[] = [];
    const links = new Map<string, any>();
    const document = {
      head: {
        appendChild: vi.fn((link: any) => {
          links.set(link.href, link);
          appendedHrefs.push(link.href);
          queueMicrotask(() => link.onload());
        }),
      },
      querySelector: vi.fn((selector: string) => {
        const href = selector.match(/href="([^"]+)"/)?.[1];
        return href ? (links.get(href) ?? null) : null;
      }),
      createElement: vi.fn(() => ({
        setAttribute(name: string, value: string) {
          (this as any)[name] = value;
        },
      })),
    };

    const dynamicImportStarts: string[] = [];
    const importResolvers = new Map<string, () => void>();
    const dynamicImport = vi.fn(
      (id: string) =>
        new Promise((resolve) => {
          dynamicImportStarts.push(id);
          importResolvers.set(id, () => resolve({ default: id }));
        })
    );

    const exposes = await toRunnableModule(code)(
      document,
      URL,
      dynamicImport,
      'file:///repo/remoteEntry.js'
    );

    const firstLoad = exposes['./one']();
    const secondLoad = exposes['./two']();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(appendedHrefs).toEqual(['file:///repo/style.css']);
    expect(dynamicImportStarts).toHaveLength(2);
    expect(dynamicImportStarts).toContain('./one.js');
    expect(dynamicImportStarts).toContain('./two.js');

    dynamicImportStarts.forEach((id) => importResolvers.get(id)?.());
    const [firstModule, secondModule] = await Promise.all([firstLoad, secondLoad]);

    expect(firstModule).toMatchObject({ default: './one.js' });
    expect(secondModule).toMatchObject({ default: './two.js' });
    expect(dynamicImport).toHaveBeenCalledTimes(2);
    expect(document.head.appendChild).toHaveBeenCalledTimes(1);
  });

  it('deduplicates the same expose and permits retry after a failed load', async () => {
    const code = generateExposes(
      getDefaultMockOptions({
        exposes: {
          './one': { import: './one.js' } as any,
        },
      })
    );
    const error = new Error('expose failed');
    let attempts = 0;
    const dynamicImport = vi.fn(() => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(error) : Promise.resolve({ default: './one.js' });
    });

    const exposes = await toRunnableModule(code)(
      undefined,
      URL,
      dynamicImport,
      'file:///repo/remoteEntry.js'
    );

    const first = exposes['./one']();
    const second = exposes['./one']();
    await expect(first).rejects.toBe(error);
    await expect(second).rejects.toBe(error);

    await expect(exposes['./one']()).resolves.toMatchObject({ default: './one.js' });
    expect(dynamicImport).toHaveBeenCalledTimes(2);
  });

  it('waits for remote dependency pending before resolving an exposed module', async () => {
    const code = generateExposes(
      getDefaultMockOptions({
        exposes: {
          './one': { import: './one.js' } as any,
        },
      })
    );

    let resolveDependency!: () => void;
    const dependencyPending = new Promise<void>((resolve) => {
      resolveDependency = resolve;
    });
    const dynamicImport = vi.fn(() =>
      Promise.resolve({
        default: './one.js',
        __mf_remote_dependency_pending: dependencyPending,
      })
    );

    const exposes = await toRunnableModule(code)(
      undefined,
      URL,
      dynamicImport,
      'file:///repo/remoteEntry.js'
    );

    let settled = false;
    const load = exposes['./one']().then((mod) => {
      settled = true;
      return mod;
    });
    await flushMicrotasks();

    expect(settled).toBe(false);

    resolveDependency();
    await expect(load).resolves.toMatchObject({ default: './one.js' });
    expect(settled).toBe(true);
  });

  it('rejects expose loading when remote dependency pending rejects', async () => {
    const code = generateExposes(
      getDefaultMockOptions({
        exposes: {
          './one': { import: './one.js' } as any,
        },
      })
    );

    const dependencyError = new Error('remote dependency failed');
    const dynamicImport = vi.fn(() =>
      Promise.resolve({
        default: './one.js',
        __mf_remote_dependency_pending: Promise.reject(dependencyError),
      })
    );

    const exposes = await toRunnableModule(code)(
      undefined,
      URL,
      dynamicImport,
      'file:///repo/remoteEntry.js'
    );

    await expect(exposes['./one']()).rejects.toBe(dependencyError);
  });

  it('rejects when a css asset fails to load before importing module', async () => {
    const code = generateExposes(
      getDefaultMockOptions({
        exposes: {
          './one': { import: './one.js' } as any,
        },
        bundleAllCSS: true as any,
      })
    ).replace(
      `"${getExposesCssMapPlaceholder()}"`,
      JSON.stringify({
        './one': ['./broken.css'],
      })
    );

    const document = {
      head: {
        appendChild: vi.fn((link: any) => {
          queueMicrotask(() => link.onerror());
        }),
      },
      querySelector: vi.fn(() => null),
      createElement: vi.fn(() => ({
        setAttribute(name: string, value: string) {
          (this as any)[name] = value;
        },
      })),
    };
    const dynamicImport = vi.fn();

    const exposes = await toRunnableModule(code)(
      document,
      URL,
      dynamicImport,
      'file:///repo/remoteEntry.js'
    );

    await expect(exposes['./one']()).rejects.toThrow(
      '[Module Federation] Failed to load CSS asset: file:///repo/broken.css'
    );
    expect(dynamicImport).not.toHaveBeenCalled();
  });
});

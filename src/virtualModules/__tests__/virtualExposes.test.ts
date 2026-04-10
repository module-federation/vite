import { describe, expect, it, vi } from 'vitest';
import {
  generateExposes,
  getExposesCssMapPlaceholder,
  getVirtualExposesId,
} from '../virtualExposes';
import { getDefaultMockOptions } from '../../utils/__tests__/helpers';

function toRunnableModule(code: string) {
  const transformed = code
    .replace('export default', 'return')
    .replaceAll('import.meta.url', '__importMetaUrl')
    .replace(/import\((".*?")\)/g, '__dynamicImport($1)');

  const factory = new Function(
    'document',
    'URL',
    '__dynamicImport',
    '__importMetaUrl',
    `return (async () => {${transformed}\n})();`
  ) as (
    document: any,
    URLCtor: typeof URL,
    dynamicImport: (id: string) => Promise<unknown>,
    importMetaUrl: string
  ) => Promise<Record<string, () => Promise<unknown>>>;

  return factory;
}

async function flushMicrotasks() {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await Promise.resolve();
}

describe('virtualExposes', () => {
  it('scopes virtual id by name and filename and sanitizes invalid chars', () => {
    expect(
      getVirtualExposesId({
        name: '@scope/remote.app',
        filename: 'nested/remoteEntry.js?x=1',
      } as any)
    ).toBe('virtual:mf-exposes:_scope_remote_app__nested_remoteEntry_js_x_1');
  });

  it('emits css placeholder only when bundleAllCSS is enabled', () => {
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

    expect(noCssBundleCode).toContain('const cssAssetMap = {};');
    expect(cssBundleCode).toContain(`const cssAssetMap = "${getExposesCssMapPlaceholder()}";`);
  });

  it('injects css once and serializes module imports across concurrent expose loads', async () => {
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
        const href = selector.match(/data-mf-href="([^"]+)"/)?.[1];
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

    expect(appendedHrefs).toEqual(['file:///repo/style.css']);
    expect(dynamicImportStarts).toHaveLength(1);

    const firstStartedImport = dynamicImportStarts[0];
    importResolvers.get(firstStartedImport)?.();
    await flushMicrotasks();

    expect(dynamicImportStarts).toHaveLength(2);
    expect(dynamicImportStarts).toContain('./one.js');
    expect(dynamicImportStarts).toContain('./two.js');

    const secondStartedImport = dynamicImportStarts.find((id) => id !== firstStartedImport)!;
    importResolvers.get(secondStartedImport)?.();
    const [firstModule, secondModule] = await Promise.all([firstLoad, secondLoad]);

    expect(firstModule).toMatchObject({ default: './one.js' });
    expect(secondModule).toMatchObject({ default: './two.js' });
    expect(dynamicImport).toHaveBeenCalledTimes(2);
    expect(document.head.appendChild).toHaveBeenCalledTimes(1);
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

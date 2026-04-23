import {
  createEmptyAssetMap,
  trackAsset,
  isCSSFile,
  collectCssAssets,
  processModuleAssets,
  addCssAssetsToAllExports,
  deduplicateAssets,
  buildFileToShareKeyMap,
} from '../cssModuleHelpers';
import type { OutputBundleItem, PreloadMap } from '../cssModuleHelpers';
import { normalizeModuleFederationOptions } from '../normalizeModuleFederationOptions';
import type { OutputAsset, OutputChunk } from 'rollup';

type OutputChunkItem = Extract<OutputBundleItem, { type: 'chunk' }>;
type RenderedModule = NonNullable<OutputChunk['modules']>[string];

function createRenderedModule(): RenderedModule {
  return {
    code: '',
    originalLength: 0,
    removedExports: [],
    renderedExports: [],
    renderedLength: 0,
  };
}

function createAsset(fileName: string): OutputAsset {
  return {
    type: 'asset',
    fileName,
    name: fileName,
    names: [fileName],
    originalFileName: null,
    originalFileNames: [],
    source: '',
    needsCodeReference: false,
  };
}

function createChunk(fileName: string, overrides: Partial<OutputChunkItem> = {}): OutputChunkItem {
  return {
    type: 'chunk',
    fileName,
    name: fileName,
    code: '',
    map: null,
    preliminaryFileName: fileName,
    sourcemapFileName: null,
    facadeModuleId: null,
    isDynamicEntry: false,
    isEntry: false,
    moduleIds: [],
    exports: [],
    modules: {},
    dynamicImports: [],
    importedBindings: {},
    imports: [],
    referencedFiles: [],
    ...overrides,
  };
}

describe('cssModuleHelpers', () => {
  describe('createEmptyAssetMap', () => {
    it('creates empty asset maps for js and css', () => {
      const result = createEmptyAssetMap();
      expect(result).toEqual({
        js: { sync: [], async: [] },
        css: { sync: [], async: [] },
      });
    });
  });

  describe('trackAsset', () => {
    let map: PreloadMap;

    beforeEach(() => {
      map = {};
    });

    it('tracks sync js asset', () => {
      trackAsset(map, 'module1', 'file.js', false, 'js');
      expect(map).toEqual({
        module1: {
          js: { sync: ['file.js'], async: [] },
          css: { sync: [], async: [] },
        },
      });
    });

    it('tracks async css asset', () => {
      trackAsset(map, 'module2', 'styles.css', true, 'css');
      expect(map).toEqual({
        module2: {
          js: { sync: [], async: [] },
          css: { sync: [], async: ['styles.css'] },
        },
      });
    });

    it('deduplicates assets', () => {
      trackAsset(map, 'module1', 'file.js', false, 'js');
      trackAsset(map, 'module1', 'file.js', false, 'js');
      expect(map.module1.js.sync).toEqual(['file.js']);
    });
  });

  describe('isCSSFile', () => {
    it.each([
      ['styles.css', true],
      ['styles.scss', true],
      ['styles.less', true],
      ['script.js', false],
      ['image.png', false],
      ['file.txt', false],
    ])('detects %s as CSS: %s', (filename, expected) => {
      expect(isCSSFile(filename)).toBe(expected);
    });
  });

  describe('collectCssAssets', () => {
    it('collects css assets from bundle', () => {
      const bundle = {
        'styles.css': createAsset('styles.css'),
        'script.js': createChunk('script.js'),
        'other.css': createAsset('other.css'),
      } satisfies Record<string, OutputBundleItem>;

      const result = collectCssAssets(bundle);
      expect(result).toEqual(new Set(['styles.css', 'other.css']));
    });

    it('ignores non-css assets', () => {
      const bundle = {
        'script.js': createChunk('script.js'),
        'image.png': createAsset('image.png'),
      } satisfies Record<string, OutputBundleItem>;

      const result = collectCssAssets(bundle);
      expect(result.size).toBe(0);
    });
  });

  describe('processModuleAssets', () => {
    it('processes module assets', () => {
      const bundle = {
        'chunk.js': {
          ...createChunk('chunk.js'),
          modules: {
            module1: createRenderedModule(),
            module2: createRenderedModule(),
          },
          dynamicImports: ['async.js'],
        },
        'async.js': createChunk('async.js'),
      } satisfies Record<string, OutputBundleItem>;

      const filesMap = {};
      const moduleMatcher = (path: string) => path;

      processModuleAssets(bundle, filesMap, moduleMatcher);

      expect(filesMap).toEqual({
        module1: {
          js: { sync: ['chunk.js'], async: ['async.js'] },
          css: { sync: [], async: [] },
        },
        module2: {
          js: { sync: ['chunk.js'], async: ['async.js'] },
          css: { sync: [], async: [] },
        },
      });
    });

    it('tracks CSS assets from viteMetadata.importedCss', () => {
      const bundle = {
        'App-abc123.js': {
          ...createChunk('App-abc123.js'),
          modules: {
            '/src/App.tsx': createRenderedModule(),
            '/src/App.css.ts': createRenderedModule(),
            '/src/App.css.ts.vanilla.css': createRenderedModule(),
          },
          dynamicImports: [],
          viteMetadata: {
            importedCss: new Set<string>(['app.css']),
            importedAssets: new Set<string>(),
          },
        },
        'app.css': createAsset('app.css'),
      } satisfies Record<string, OutputBundleItem>;

      const filesMap = {};
      const moduleMatcher = (path: string) => (path === '/src/App.tsx' ? path : undefined);

      processModuleAssets(bundle, filesMap, moduleMatcher);

      expect(filesMap).toEqual({
        '/src/App.tsx': {
          js: { sync: ['App-abc123.js'], async: [] },
          css: { sync: ['app.css'], async: [] },
        },
      });
    });

    it('tracks CSS assets when chunk contains CSS modules but viteMetadata.importedCss is empty', () => {
      const bundle = {
        'App-abc123.js': {
          ...createChunk('App-abc123.js'),
          modules: {
            '/src/App.tsx': createRenderedModule(),
            '/src/App.css.ts': createRenderedModule(),
            '/src/App.css.ts.vanilla.css': createRenderedModule(),
          },
          dynamicImports: [],
          viteMetadata: {
            importedCss: new Set<string>(),
            importedAssets: new Set<string>(),
          },
        },
        'app.css': createAsset('app.css'),
      } satisfies Record<string, OutputBundleItem>;

      const filesMap = {};
      const moduleMatcher = (path: string) => (path === '/src/App.tsx' ? path : undefined);

      processModuleAssets(bundle, filesMap, moduleMatcher);

      expect(filesMap).toEqual({
        '/src/App.tsx': {
          js: { sync: ['App-abc123.js'], async: [] },
          css: { sync: ['app.css'], async: [] },
        },
      });
    });
  });

  describe('addCssAssetsToAllExports', () => {
    it('adds css assets to all exports', () => {
      const filesMap = {
        module1: createEmptyAssetMap(),
        module2: createEmptyAssetMap(),
      };
      const cssAssets = new Set(['styles.css']);

      addCssAssetsToAllExports(filesMap, cssAssets);

      expect(filesMap.module1.css.sync).toEqual(['styles.css']);
      expect(filesMap.module2.css.sync).toEqual(['styles.css']);
    });
  });

  describe('deduplicateAssets', () => {
    it('deduplicates assets', () => {
      const filesMap = {
        module1: {
          js: { sync: ['file.js', 'file.js'], async: [] },
          css: { sync: ['styles.css', 'styles.css'], async: [] },
        },
      };

      const result = deduplicateAssets(filesMap);
      expect(result.module1.js.sync).toEqual(['file.js']);
      expect(result.module1.css.sync).toEqual(['styles.css']);
    });
  });

  describe('buildFileToShareKeyMap', () => {
    it('builds file to share key map', async () => {
      const shareKeys = new Set(['react']);
      const resolveFn = vi.fn().mockResolvedValue({ id: 'path/to/react.js' });

      // Mock getNormalizeModuleFederationOptions
      vi.mock('../normalizeModuleFederationOptions', () => ({
        getNormalizeModuleFederationOptions: vi.fn(() => ({
          name: 'test-app',
          virtualModuleDir: '__mf_virtual_test',
          bundleAllCSS: false,
        })),
        normalizeModuleFederationOptions: vi.fn((options) => ({
          name: 'test-app',
          virtualModuleDir: '__mf_virtual_test',
          bundleAllCSS: options.bundleAllCSS || false,
        })),
      }));

      const result = await buildFileToShareKeyMap(shareKeys, resolveFn);
      expect(result.get('path/to/react.js')).toBe('react');
    });
  });

  describe('bundleAllCSS option', () => {
    it('should default bundleAllCSS to false when not specified', () => {
      const options = normalizeModuleFederationOptions({
        name: 'test-app',
        exposes: {
          './Button': './src/Button.jsx',
        },
      });

      expect(options.bundleAllCSS).toBe(false);
    });

    it('should set bundleAllCSS to false when explicitly set to false', () => {
      const options = normalizeModuleFederationOptions({
        name: 'test-app',
        exposes: {
          './Button': './src/Button.jsx',
        },
        bundleAllCSS: false,
      });

      expect(options.bundleAllCSS).toBe(false);
    });

    it('should set bundleAllCSS to true when explicitly set to true', () => {
      const options = normalizeModuleFederationOptions({
        name: 'test-app',
        exposes: {
          './Button': './src/Button.jsx',
        },
        bundleAllCSS: true,
      });

      expect(options.bundleAllCSS).toBe(true);
    });
  });
});

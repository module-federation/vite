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
        'styles.css': { type: 'asset', fileName: 'styles.css' },
        'script.js': { type: 'chunk', fileName: 'script.js' },
        'other.css': { type: 'asset', fileName: 'other.css' },
      } as Record<string, OutputBundleItem>;

      const result = collectCssAssets(bundle);
      expect(result).toEqual(new Set(['styles.css', 'other.css']));
    });

    it('ignores non-css assets', () => {
      const bundle = {
        'script.js': { type: 'chunk', fileName: 'script.js' },
        'image.png': { type: 'asset', fileName: 'image.png' },
      } as Record<string, OutputBundleItem>;

      const result = collectCssAssets(bundle);
      expect(result.size).toBe(0);
    });
  });

  describe('processModuleAssets', () => {
    it('processes module assets', () => {
      const bundle = {
        'chunk.js': {
          type: 'chunk',
          fileName: 'chunk.js',
          modules: {
            module1: {},
            module2: {},
          },
          dynamicImports: ['async.js'],
        },
        'async.js': {
          type: 'chunk',
          fileName: 'async.js',
        },
      } as Record<string, OutputBundleItem>;

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

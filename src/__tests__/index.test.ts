import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Plugin } from 'vite';

const { mfWarn } = vi.hoisted(() => ({
  mfWarn: vi.fn(),
}));

const { getLoadFileContent, setLoadFileContent } = vi.hoisted(() => {
  let content: string | undefined;
  return {
    getLoadFileContent: () => content,
    setLoadFileContent: (c: string | undefined) => {
      content = c;
    },
  };
});

vi.mock('../utils/packageUtils', async () => {
  const actual =
    await vi.importActual<typeof import('../utils/packageUtils')>('../utils/packageUtils');
  return {
    ...actual,
    hasPackageDependency: () => false,
    setPackageDetectionCwd: vi.fn(),
  };
});

vi.mock('../utils/logger', async () => {
  const actual = await vi.importActual<typeof import('../utils/logger')>('../utils/logger');
  return {
    ...actual,
    mfWarn,
  };
});

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    readFileSync: (filePath: any, ...args: any[]) => {
      const content = getLoadFileContent();
      if (
        content !== undefined &&
        typeof filePath === 'string' &&
        (filePath.includes('__loadShare__') || filePath.includes('__loadRemote__'))
      ) {
        return content;
      }
      return actual.readFileSync(filePath, ...args);
    },
  };
});

import { federation } from '../index';
import { LOAD_REMOTE_TAG, LOAD_SHARE_TAG } from '../virtualModules';
import { virtualRuntimeInitStatus } from '../virtualModules/virtualRuntimeInitStatus';

function getEsmShimsPlugin(): Plugin {
  const plugin = federation({
    name: 'host',
    filename: 'remoteEntry.js',
  }).find((entry) => entry.name === 'module-federation-esm-shims');

  if (!plugin) throw new Error('module-federation-esm-shims plugin not found');
  return plugin;
}

function getFixPreloadPlugin(): Plugin {
  const plugin = federation({
    name: 'remote',
    filename: 'remoteEntry.js',
    exposes: {
      '.': './src/App.tsx',
    },
  }).find((entry) => entry.name === 'module-federation-fix-preload');

  if (!plugin) throw new Error('module-federation-fix-preload plugin not found');
  return plugin;
}

describe('module-federation-esm-shims', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('removes codeSplitting false and warns once', () => {
    const plugin = getEsmShimsPlugin();
    const config: any = {
      build: {
        rollupOptions: { output: { codeSplitting: false } },
        rolldownOptions: { output: { codeSplitting: false } },
      },
    };

    const configHook = typeof plugin.config === 'function' ? plugin.config : plugin.config?.handler;
    configHook?.call({} as any, config, { command: 'build', mode: 'test' });

    expect(config.build.rollupOptions.output.codeSplitting).toBeUndefined();
    expect(config.build.rolldownOptions.output.codeSplitting).toBeUndefined();
    expect(mfWarn).toHaveBeenCalledTimes(1);
  });

  it('keeps federation chunks isolated and preserves existing manualChunks behavior', () => {
    const plugin = getEsmShimsPlugin();
    const runtimeInitId = virtualRuntimeInitStatus.getImportId();
    const functionOutput = {
      manualChunks: vi.fn((_id: string) => 'existing-fn-chunk'),
    };
    const objectOutput = {
      manualChunks: {
        vendor: ['react'],
      },
    };
    const config: any = {
      build: {
        rollupOptions: { output: functionOutput },
        rolldownOptions: { output: objectOutput },
      },
    };

    const configHook = typeof plugin.config === 'function' ? plugin.config : plugin.config?.handler;
    configHook?.call({} as any, config, { command: 'build', mode: 'test' });

    expect(functionOutput.manualChunks(`/virtual/${runtimeInitId}`)).toBe('runtimeInit');
    expect(functionOutput.manualChunks(`/virtual/react${LOAD_SHARE_TAG}chunk.js`)).toBe(
      `react${LOAD_SHARE_TAG}chunk.js`
    );
    expect(functionOutput.manualChunks('/src/custom.ts')).toBe('existing-fn-chunk');

    expect((objectOutput.manualChunks as unknown as Function)('/src/react/index.ts')).toBe(
      'vendor'
    );
    expect(
      (objectOutput.manualChunks as unknown as Function)('/src/other/index.ts')
    ).toBeUndefined();
  });
});

describe('module-federation-esm-shims load hook', () => {
  let loadHook: Function;

  beforeEach(() => {
    vi.clearAllMocks();
    setLoadFileContent(undefined);
    const plugin = getEsmShimsPlugin();
    const load = typeof plugin.load === 'function' ? plugin.load : (plugin.load as any)?.handler;
    if (!load) throw new Error('load hook not found');
    loadHook = load;
  });

  const rolldownCtx = { meta: { rolldownVersion: '1.0.0' } };
  const rollupCtx = { meta: {} };

  it('returns undefined for ids starting with null byte', () => {
    const result = loadHook.call(rolldownCtx, '\0some-module');
    expect(result).toBeUndefined();
  });

  it('returns undefined for ids without load tags', () => {
    const result = loadHook.call(rolldownCtx, '/src/app.ts');
    expect(result).toBeUndefined();
  });

  describe('rolldown path', () => {
    describe('LOAD_SHARE_TAG – build path (bare prebuild import)', () => {
      it('removes bare prebuild imports', () => {
        setLoadFileContent(
          [
            'import "virtual:__prebuild__react";',
            'const exportModule = await loadShare("react");',
            'export default exportModule',
          ].join('\n')
        );

        const result = loadHook.call(rolldownCtx, `/virtual/react${LOAD_SHARE_TAG}chunk.js`);
        expect(result.code).not.toContain('__prebuild__');
        expect(result.code).toContain(
          'export default exportModule.__esModule ? exportModule.default : exportModule'
        );
      });

      it('removes all bare prebuild imports when there are multiple', () => {
        setLoadFileContent(
          [
            'import "virtual:__prebuild__react";',
            'import "virtual:__prebuild__react-dom";',
            'const exportModule = await loadShare("react");',
            'export default exportModule',
          ].join('\n')
        );

        const result = loadHook.call(rolldownCtx, `/virtual/react${LOAD_SHARE_TAG}chunk.js`);
        expect(result.code).not.toContain('import');
        expect(result.code).not.toContain('__prebuild__');
      });

      it('strips export star from prebuild', () => {
        setLoadFileContent(
          [
            'import "virtual:__prebuild__react";',
            'export * from "virtual:__prebuild__react";',
            'const exportModule = await loadShare("react");',
            'export default exportModule',
          ].join('\n')
        );

        const result = loadHook.call(rolldownCtx, `/virtual/react${LOAD_SHARE_TAG}chunk.js`);
        expect(result.code).not.toContain('export *');
      });

      it('does not convert const destructure to assignment (build path)', () => {
        setLoadFileContent(
          [
            'import "virtual:__prebuild__react";',
            'const exportModule = await loadShare("react");',
            'const { useState } = exportModule;',
            'export default exportModule',
          ].join('\n')
        );

        const result = loadHook.call(rolldownCtx, `/virtual/react${LOAD_SHARE_TAG}chunk.js`);
        expect(result.code).toContain('const { useState } = exportModule;');
      });
    });

    describe('LOAD_SHARE_TAG – dev path (namespace import)', () => {
      it('preserves namespace import and converts const destructure to assignment', () => {
        setLoadFileContent(
          [
            'import * as __mf_prebuild_ns__ from "virtual:__prebuild__react_ns";',
            'export * from "virtual:__prebuild__react_ns";',
            'const exportModule = await loadShare("react");',
            'const { useState, useEffect } = exportModule;',
            'export default exportModule',
          ].join('\n')
        );

        const result = loadHook.call(rolldownCtx, `/virtual/react${LOAD_SHARE_TAG}chunk.js`);
        expect(result.code).toContain('import * as __mf_prebuild_ns__');
        expect(result.code).toMatch(/\(\{\s*useState,\s*useEffect\s*\}\s*=\s*exportModule\);/);
        expect(result.code).not.toContain('const {');
        expect(result.code).not.toContain('export *');
        expect(result.code).toContain(
          'export default exportModule.__esModule ? exportModule.default : exportModule'
        );
      });

      it('handles dev path without destructure', () => {
        setLoadFileContent(
          [
            'import * as __mf_prebuild_ns__ from "virtual:__prebuild__react_ns";',
            'const exportModule = await loadShare("react");',
            'export default exportModule',
          ].join('\n')
        );

        const result = loadHook.call(rolldownCtx, `/virtual/react${LOAD_SHARE_TAG}chunk.js`);
        expect(result.code).toContain('import * as __mf_prebuild_ns__');
        expect(result.code).toContain(
          'export default exportModule.__esModule ? exportModule.default : exportModule'
        );
      });
    });

    describe('LOAD_REMOTE_TAG', () => {
      it('strips prebuild imports and transforms default export', () => {
        setLoadFileContent(
          [
            'import "virtual:__prebuild__remote";',
            'const exportModule = await loadRemote("remote/module");',
            'export default exportModule',
          ].join('\n')
        );

        const result = loadHook.call(rolldownCtx, `/virtual/remote${LOAD_REMOTE_TAG}chunk.js`);
        expect(result.code).not.toContain('__prebuild__');
        expect(result.code).toContain(
          'export default exportModule.__esModule ? exportModule.default : exportModule'
        );
      });
    });
  });

  describe('rollup path', () => {
    it('strips prebuild imports and export star, adds syntheticNamedExports', () => {
      setLoadFileContent(
        [
          'import "virtual:__prebuild__react";',
          'export * from "virtual:__prebuild__react";',
          'const exportModule = await loadShare("react");',
          'export default exportModule',
        ].join('\n')
      );

      const result = loadHook.call(rollupCtx, `/virtual/react${LOAD_SHARE_TAG}chunk.js`);
      expect(result.code).not.toContain('import');
      expect(result.code).not.toContain('export *');
      expect(result.code).toContain('export const __moduleExports = exportModule;');
      expect(result.code).toContain(
        'export default exportModule.__esModule ? exportModule.default : exportModule'
      );
      expect(result.syntheticNamedExports).toBe('__moduleExports');
    });
  });
});

describe('module-federation-fix-preload', () => {
  it('keeps nested output paths working', () => {
    const plugin = getFixPreloadPlugin();
    const bundle = {
      'static/js/preload-helper-abc.js': {
        type: 'chunk',
        fileName: 'static/js/preload-helper-abc.js',
        code: 'const u=function(e){return new URL("../"+e,import.meta.url).href};modulepreload',
      },
    };

    plugin.generateBundle?.call({} as any, {} as any, bundle as any);

    expect(bundle['static/js/preload-helper-abc.js'].code).toContain(
      'new URL("..\\u002F..\\u002F"+e,import.meta.url).href'
    );
  });

  it('keeps root output paths working', () => {
    const plugin = getFixPreloadPlugin();
    const bundle = {
      'preload-helper-abc.js': {
        type: 'chunk',
        fileName: 'preload-helper-abc.js',
        code: 'const u=function(e){return new URL("../"+e,import.meta.url).href};modulepreload',
      },
    };

    plugin.generateBundle?.call({} as any, {} as any, bundle as any);

    expect(bundle['preload-helper-abc.js'].code).toContain('new URL(e,import.meta.url).href');
  });
});

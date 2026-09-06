import { describe, expect, it } from 'vitest';
import {
  ensureTrailingSlash,
  getBasePath,
  getCommonSharedSubpathFromNodeModulePath,
  getCommonSharedSubpaths,
  getMatchingNodeModuleSubpath,
  isAssetLikeImport,
  isNuxtClientBase,
  isNodeModulePath,
  normalizeNodeModulePath,
  removeTrailingSlash,
  resolvePublicPath,
} from '../pathNormalization';
import type { NormalizedModuleFederationOptions } from '../normalizeModuleFederationOptions';

const mfPublicPathOption = (publicPath?: string) =>
  ({ publicPath }) as unknown as NormalizedModuleFederationOptions;

describe('pathNormalization', () => {
  it('removes one trailing slash', () => {
    expect(removeTrailingSlash('/vite/')).toBe('/vite');
    expect(removeTrailingSlash('/vite')).toBe('/vite');
  });

  it('ensures one trailing slash', () => {
    expect(ensureTrailingSlash('/vite')).toBe('/vite/');
    expect(ensureTrailingSlash('/vite/')).toBe('/vite/');
  });

  it('normalizes Vite base paths', () => {
    expect(getBasePath('/_nuxt/')).toBe('/_nuxt');
    expect(getBasePath(undefined)).toBe('');
  });

  it('detects Nuxt client base paths', () => {
    expect(isNuxtClientBase('/_nuxt/')).toBe(true);
    expect(isNuxtClientBase('/app/_nuxt/')).toBe(true);
    expect(isNuxtClientBase('/assets/')).toBe(false);
  });

  it('normalizes node_modules paths', () => {
    expect(normalizeNodeModulePath('C:\\repo\\node_modules\\react\\index.js?v=1')).toBe(
      'C:/repo/node_modules/react/index.js'
    );
    expect(isNodeModulePath('/repo/node_modules/react/index.js')).toBe(true);
    expect(isNodeModulePath('C:\\repo\\node_modules\\react\\index.js')).toBe(true);
    expect(isNodeModulePath('/repo/src/App.tsx')).toBe(false);
  });

  it('removes queries without regex backtracking', () => {
    expect(normalizeNodeModulePath(`/repo/file.js?${'?'.repeat(10_000)}\n`)).toBe('/repo/file.js');
  });

  it('matches the longest node_modules subpath candidate', () => {
    expect(
      getMatchingNodeModuleSubpath('/repo/node_modules/react-dom/server.browser.js?v=1', [
        'react-dom/server',
        'react-dom/server.browser',
      ])
    ).toBe('react-dom/server.browser');
  });

  it('does not treat a dotted sibling file as a shorter candidate (extension boundary)', () => {
    // `server.browser.js` must not match shared key `react-dom/server` just because
    // the path contains `/node_modules/react-dom/server.`. The `.` after the
    // candidate has to be a module-file extension, not another filename segment.
    expect(
      getMatchingNodeModuleSubpath('/repo/node_modules/react-dom/server.browser.js', [
        'react-dom/server',
      ])
    ).toBeUndefined();
    expect(
      getMatchingNodeModuleSubpath('C:\\repo\\node_modules\\react-dom\\server.browser.js?v=1', [
        'react-dom/server',
      ])
    ).toBeUndefined();

    expect(
      getMatchingNodeModuleSubpath('/repo/node_modules/react-dom/server.js', ['react-dom/server'])
    ).toBe('react-dom/server');
    expect(
      getMatchingNodeModuleSubpath('/repo/node_modules/react-dom/client.mjs', ['react-dom/client'])
    ).toBe('react-dom/client');
    expect(
      getMatchingNodeModuleSubpath('/repo/node_modules/react-dom/client.js#app', [
        'react-dom/client',
      ])
    ).toBe('react-dom/client');
    expect(
      getMatchingNodeModuleSubpath('/repo/node_modules/react-dom/server/render.js', [
        'react-dom/server',
      ])
    ).toBe('react-dom/server');

    // A dotted sibling earlier in the path must not hide a later exact module.
    expect(
      getMatchingNodeModuleSubpath(
        '/repo/node_modules/react-dom/server.browser.js/vendor/node_modules/react-dom/server.js',
        ['react-dom/server']
      )
    ).toBe('react-dom/server');
  });

  it('detects common shared subpaths from node_modules paths', () => {
    expect(
      getCommonSharedSubpathFromNodeModulePath(
        'C:\\repo\\node_modules\\react\\jsx-runtime.js',
        'react'
      )
    ).toBe('react/jsx-runtime');
  });

  it('lists only browser-safe react-dom common subpaths', () => {
    expect(getCommonSharedSubpaths('react-dom')).toEqual([
      'react-dom/client',
      'react-dom/profiling',
    ]);
    expect(getCommonSharedSubpaths('react-dom')).not.toContain('react-dom/server');
    expect(getCommonSharedSubpaths('react-dom')).not.toContain('react-dom/server.browser');
    expect(
      getCommonSharedSubpathFromNodeModulePath(
        '/repo/node_modules/react-dom/client.js',
        'react-dom'
      )
    ).toBe('react-dom/client');
    expect(
      getCommonSharedSubpathFromNodeModulePath(
        '/repo/node_modules/react-dom/server.browser.js',
        'react-dom'
      )
    ).toBeUndefined();
  });

  it('lists solid-js jsx runtimes and zustand middleware/shallow as common subpaths', () => {
    expect(getCommonSharedSubpaths('solid-js')).toEqual([
      'solid-js/web',
      'solid-js/store',
      'solid-js/html',
      'solid-js/h',
      'solid-js/jsx-runtime',
      'solid-js/jsx-dev-runtime',
    ]);
    expect(getCommonSharedSubpaths('zustand')).toEqual([
      'zustand/vanilla',
      'zustand/react',
      'zustand/middleware',
      'zustand/shallow',
    ]);
    expect(getCommonSharedSubpaths('zustand')).not.toContain('zustand/context');
    expect(
      getCommonSharedSubpathFromNodeModulePath(
        '/repo/node_modules/solid-js/jsx-runtime.js',
        'solid-js'
      )
    ).toBe('solid-js/jsx-runtime');
    expect(
      getCommonSharedSubpathFromNodeModulePath(
        '/repo/node_modules/zustand/middleware.js',
        'zustand'
      )
    ).toBe('zustand/middleware');
  });

  it.each([
    'styles.css',
    'styles.scss?inline',
    'icon.svg#sprite',
    'sound.mp3',
    'manifest.webmanifest?url',
    'document.pdf?raw',
    'image.jxl',
    'movie.mov',
  ])('detects asset-like imports (%s)', (source) => {
    expect(isAssetLikeImport(source)).toBe(true);
  });

  it('does not treat JavaScript module imports as asset-like', () => {
    expect(isAssetLikeImport('@ui-lib/button')).toBe(false);
    expect(isAssetLikeImport('react/jsx-runtime')).toBe(false);
  });
});

describe('resolvePublicPath', () => {
  it('returns an explicitly configured publicPath verbatim', () => {
    expect(
      resolvePublicPath(mfPublicPathOption('https://cdn.example.com/'), '/anything/', '/anything/')
    ).toBe('https://cdn.example.com/');
  });

  it('treats an explicit "auto" publicPath as unset and derives from base', () => {
    expect(resolvePublicPath(mfPublicPathOption('auto'), '/base/', '/base/')).toBe('/base/');
  });

  it('uses an absolute base as the publicPath, normalized with a trailing slash', () => {
    expect(resolvePublicPath(mfPublicPathOption(), '/base/', '/base/')).toBe('/base/');
    expect(resolvePublicPath(mfPublicPathOption(), '/base', '/base')).toBe('/base/');
  });

  it('infers publicPath at runtime to be "auto" for a relative base "./"', () => {
    expect(resolvePublicPath(mfPublicPathOption(), './', './')).toBe('auto');
  });
});

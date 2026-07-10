import { describe, expect, it } from 'vitest';
import {
  ensureTrailingSlash,
  getBasePath,
  getCommonSharedSubpathFromNodeModulePath,
  getMatchingNodeModuleSubpath,
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

  it('matches the longest node_modules subpath candidate', () => {
    expect(
      getMatchingNodeModuleSubpath('/repo/node_modules/react-dom/server.browser.js?v=1', [
        'react-dom/server',
        'react-dom/server.browser',
      ])
    ).toBe('react-dom/server.browser');
  });

  it('detects common shared subpaths from node_modules paths', () => {
    expect(
      getCommonSharedSubpathFromNodeModulePath(
        'C:\\repo\\node_modules\\react\\jsx-runtime.js',
        'react'
      )
    ).toBe('react/jsx-runtime');
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

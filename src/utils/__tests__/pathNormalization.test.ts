import { describe, expect, it } from 'vitest';
import {
  ensureTrailingSlash,
  getCommonSharedSubpathFromNodeModulePath,
  getMatchingNodeModuleSubpath,
  isNodeModulePath,
  normalizeNodeModulePath,
  removeTrailingSlash,
} from '../pathNormalization';

describe('pathNormalization', () => {
  it('removes one trailing slash', () => {
    expect(removeTrailingSlash('/vite/')).toBe('/vite');
    expect(removeTrailingSlash('/vite')).toBe('/vite');
  });

  it('ensures one trailing slash', () => {
    expect(ensureTrailingSlash('/vite')).toBe('/vite/');
    expect(ensureTrailingSlash('/vite/')).toBe('/vite/');
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

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import * as path from 'node:path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getInstalledPackageEntry,
  getInstalledPackageJson,
  getPackageNameFromNodeModulePath,
  getSharedCacheDescriptor,
  getSharedCacheKey,
  resolveImportPath,
  sharedCacheHelperCode,
} from '../packageUtils';

describe('getInstalledPackageJson', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('finds packages in pnpm store layout when direct resolution fails', () => {
    const packageName = 'mf-test-scheduler';
    const root = mkdtempSync(path.join(tmpdir(), 'mf-vite-pnpm-'));
    tempDirs.push(root);

    mkdirSync(path.join(root, 'apps/host'), { recursive: true });
    mkdirSync(
      path.join(root, `node_modules/.pnpm/${packageName}@0.27.0/node_modules/${packageName}`),
      {
        recursive: true,
      }
    );
    writeFileSync(
      path.join(root, 'apps/host/package.json'),
      JSON.stringify({ name: 'host', type: 'module' })
    );
    writeFileSync(
      path.join(
        root,
        `node_modules/.pnpm/${packageName}@0.27.0/node_modules/${packageName}/package.json`
      ),
      JSON.stringify({ name: packageName, version: '0.27.0' })
    );

    const installed = getInstalledPackageJson(packageName, { cwd: path.join(root, 'apps/host') });

    expect(installed?.packageJson.name).toBe(packageName);
    expect(installed?.path).toContain(
      `/node_modules/.pnpm/${packageName}@0.27.0/node_modules/${packageName}/package.json`
    );
  });

  it('prefers browser conditional exports for installed package entries', () => {
    const packageName = 'mf-test-browser-conditional';
    const root = mkdtempSync(path.join(tmpdir(), 'mf-vite-browser-'));
    tempDirs.push(root);

    const hostDir = path.join(root, 'apps/host');
    const packageDir = path.join(hostDir, 'node_modules', packageName);
    mkdirSync(path.join(packageDir, 'dist'), { recursive: true });
    writeFileSync(path.join(hostDir, 'package.json'), JSON.stringify({ name: 'host' }));
    writeFileSync(
      path.join(packageDir, 'package.json'),
      JSON.stringify({
        name: packageName,
        exports: {
          '.': {
            worker: {
              import: './dist/server.js',
            },
            browser: {
              import: './dist/browser.js',
            },
            import: './dist/browser.js',
          },
        },
      })
    );
    writeFileSync(path.join(packageDir, 'dist/server.js'), 'export const serverOnly = true;');
    writeFileSync(path.join(packageDir, 'dist/browser.js'), 'export const clientOnly = true;');

    const entry = getInstalledPackageEntry(packageName, { cwd: hostDir });

    expect(entry).toBe(path.join(packageDir, 'dist/browser.js'));
  });
});

describe('resolveImportPath', () => {
  it('returns an existing package export path', () => {
    expect(resolveImportPath('@module-federation/runtime')).toContain('@module-federation');
  });

  it('throws for exported paths that do not exist on disk', () => {
    const missing = path.join(tmpdir(), `mf-vite-missing-${Date.now()}.js`);
    expect(() => resolveImportPath(pathToFileURL(missing).href)).toThrow(/Cannot find module/);
  });
});

describe('getPackageNameFromNodeModulePath', () => {
  it('extracts unscoped and scoped package names', () => {
    expect(getPackageNameFromNodeModulePath('/repo/node_modules/vue/dist/vue.js')).toBe('vue');
    expect(getPackageNameFromNodeModulePath('/repo/node_modules/@scope/pkg/dist/index.js')).toBe(
      '@scope/pkg'
    );
  });

  it('returns undefined for non-node_modules paths', () => {
    expect(getPackageNameFromNodeModulePath('/repo/vendor/vue.js')).toBeUndefined();
  });
});

describe('getSharedCacheKey', () => {
  it('prefixes singleton shared cache keys with share scope', () => {
    expect(
      getSharedCacheKey('react', {
        scope: 'react-18',
        version: '18.3.1',
        shareConfig: { singleton: true },
      } as any)
    ).toBe('react-18:react');
  });

  it('prefixes versioned shared cache keys with share scope', () => {
    expect(
      getSharedCacheKey('react', {
        scope: 'react-19',
        version: '19.2.4',
        shareConfig: { singleton: false },
      } as any)
    ).toBe('react-19:react@19.2.4');
  });

  it('falls back to default scope when scope is missing', () => {
    expect(
      getSharedCacheKey('vue', {
        version: '3.5.0',
        shareConfig: { singleton: true },
      } as any)
    ).toBe('default:vue');
  });

  it('exposes a compatibility alias for default-scope singleton keys', () => {
    expect(
      getSharedCacheDescriptor('react', {
        scope: 'default',
        version: '19.2.7',
        shareConfig: { singleton: true },
      } as any)
    ).toEqual({
      canonical: 'default:react',
      aliases: ['react'],
    });
  });

  it('does not expose a compatibility alias for custom share scopes', () => {
    expect(
      getSharedCacheDescriptor('react', {
        scope: 'react-19',
        version: '19.2.7',
        shareConfig: { singleton: true },
      } as any)
    ).toEqual({
      canonical: 'react-19:react',
    });
  });

  it('promotes default-scope alias cache reads to the canonical key', () => {
    const runtime = new Function(
      `${sharedCacheHelperCode}
      return { read: __mfReadSharedCache, write: __mfWriteSharedCache };`
    )() as {
      read: (
        cache: Record<string, unknown>,
        descriptor: { canonical: string; aliases?: string[] }
      ) => unknown;
      write: (
        cache: Record<string, unknown>,
        descriptor: { canonical: string; aliases?: string[] },
        value: unknown
      ) => void;
    };
    const cache = { react: { marker: 'aliased-react' } };

    expect(
      runtime.read(cache, {
        canonical: 'default:react',
        aliases: ['react'],
      })
    ).toBe(cache.react);
    expect(cache).toHaveProperty('default:react', cache.react);
  });

  it('writes default-scope cache values to the canonical and alias keys', () => {
    const runtime = new Function(
      `${sharedCacheHelperCode}
      return { read: __mfReadSharedCache, write: __mfWriteSharedCache };`
    )() as {
      read: (
        cache: Record<string, unknown>,
        descriptor: { canonical: string; aliases?: string[] }
      ) => unknown;
      write: (
        cache: Record<string, unknown>,
        descriptor: { canonical: string; aliases?: string[] },
        value: unknown
      ) => void;
    };
    const cache: Record<string, unknown> = {};
    const react = { marker: 'host-react' };

    runtime.write(
      cache,
      {
        canonical: 'default:react',
        aliases: ['react'],
      },
      react
    );

    expect(cache['default:react']).toBe(react);
    expect(cache.react).toBe(react);
  });
});

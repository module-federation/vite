import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import * as path from 'node:path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedShared } from '../normalizeModuleFederationOptions';
import { createSharedSourceResolver } from '../sharedSource';

function makeShared(keys: string[]): NormalizedShared {
  return Object.fromEntries(
    keys.map((key) => [
      key,
      {
        name: key,
        version: '1.0.0',
        scope: 'default',
        from: '',
        shareConfig: { singleton: true, requiredVersion: '*' },
      },
    ])
  ) as unknown as NormalizedShared;
}

describe('createSharedSourceResolver', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
  });

  it('lets Vite resolve a shared package that is not installed under the project root', async () => {
    // e.g. `resolve.alias: { 'mf-test-vendored-only': '/vendor/node_modules/mf-test-vendored-only' }` with the package absent from the
    // project's node_modules, or a non-hoisted pnpm dependency. Node cannot find it from `root`,
    // but `context.resolve()` can; the exports pre-filter must not gate that lookup.
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'mf-vite-shared-source-')));
    tempDirs.push(root);
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'host' }));

    const vendoredEntry = '/vendor/node_modules/mf-test-vendored-only/index.js';
    const resolve = vi.fn(async (id: string) => ({
      id: id === 'mf-test-vendored-only' ? vendoredEntry : id,
      external: false,
    }));
    const resolver = createSharedSourceResolver(makeShared(['mf-test-vendored-only']), () => ({
      root,
      conditions: [],
    }));

    await expect(resolver.resolve({ resolve } as any, vendoredEntry, {})).resolves.toBe(
      'mf-test-vendored-only'
    );
    expect(resolve).toHaveBeenCalledWith(
      'mf-test-vendored-only',
      path.join(root, 'package.json'),
      expect.anything()
    );
  });

  it('skips Vite resolution for a subpath the installed package does not export', async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'mf-vite-shared-source-')));
    tempDirs.push(root);
    const packageDir = path.join(root, 'node_modules', 'mf-test-private-subpath');
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'host' }));
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      path.join(packageDir, 'package.json'),
      JSON.stringify({ name: 'mf-test-private-subpath', exports: { '.': './index.js' } })
    );

    const source = path.join(packageDir, 'internal', 'file.js');
    const resolve = vi.fn(async (id: string) => ({ id, external: false }));
    const resolver = createSharedSourceResolver(
      makeShared(['mf-test-private-subpath/internal/file.js']),
      () => ({ root, conditions: [] })
    );

    await expect(resolver.resolve({ resolve } as any, source, {})).resolves.toBeUndefined();
    expect(resolve).not.toHaveBeenCalledWith(
      'mf-test-private-subpath/internal/file.js',
      expect.anything(),
      expect.anything()
    );
  });
});

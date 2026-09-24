import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import * as path from 'node:path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedShared } from '../normalizeModuleFederationOptions';
import { createSharedSourceResolver, isSharedEntryLookup } from '../sharedSource';

function makeShared(keys: string[], shareConfig: Record<string, unknown> = {}): NormalizedShared {
  return Object.fromEntries(
    keys.map((key) => [
      key,
      {
        name: key,
        version: '1.0.0',
        scope: 'default',
        from: '',
        shareConfig: { singleton: true, requiredVersion: '*', ...shareConfig },
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

  // rolldown <= 1.2.10 can drop `custom` when this.resolve() calls overlap.
  it('recognizes an entry lookup until the last overlapping lookup for it settles', async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'mf-vite-shared-source-')));
    tempDirs.push(root);
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'host' }));

    const entry = '/vendor/node_modules/mf-test-lookup/index.js';
    const importer = path.join(root, 'package.json');
    const resolved = { id: entry, external: false };
    const settle: Array<() => void> = [];
    const resolve = vi.fn((id: string) =>
      id === entry
        ? new Promise((done) => settle.push(() => done(resolved)))
        : Promise.resolve(resolved)
    );
    const shared = makeShared(['mf-test-lookup']);
    const getConfig = () => ({ root, conditions: [] });
    // Two federation instances looking up the same entry.
    const results = Promise.all(
      [
        createSharedSourceResolver(shared, getConfig),
        createSharedSourceResolver(shared, getConfig),
      ].map((resolver) => resolver.resolve({ resolve } as any, entry, {}))
    );

    await vi.waitFor(() => expect(settle).toHaveLength(2));
    expect(isSharedEntryLookup(entry, importer, {})).toBe(true);
    settle[0]();
    await new Promise(setImmediate);
    expect(isSharedEntryLookup(entry, importer, {})).toBe(true);
    settle[1]();
    await expect(results).resolves.toEqual(['mf-test-lookup', 'mf-test-lookup']);
    expect(isSharedEntryLookup(entry, importer, {})).toBe(false);
  });

  it('matches an aliased share by its request, not its property name', async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'mf-vite-shared-source-')));
    tempDirs.push(root);
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'host' }));

    const entry = '/vendor/node_modules/mf-test-aliased/index.js';
    const resolve = vi.fn(async (id: string) => ({
      id: id === 'mf-test-aliased' ? entry : id,
      external: false,
    }));
    const shared = makeShared(['my-aliased'], {
      import: 'mf-test-aliased',
      request: 'mf-test-aliased',
      shareKey: 'mf-test-aliased',
    });
    const resolver = createSharedSourceResolver(shared, () => ({ root, conditions: [] }));

    await expect(resolver.resolve({ resolve } as any, entry, {})).resolves.toBe('mf-test-aliased');
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

  it('does not match different node_modules roots unless suffix matching is enabled', async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'mf-vite-shared-source-')));
    tempDirs.push(root);
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'host' }));

    const source = '/consumer/node_modules/mf-test-suffix-match/index.js';
    const provider = '/provider/node_modules/mf-test-suffix-match/index.js';
    const resolve = vi.fn(async (id: string) => ({
      id: id === 'mf-test-suffix-match' ? provider : id,
      external: false,
    }));

    const withoutOptIn = createSharedSourceResolver(makeShared(['mf-test-suffix-match']), () => ({
      root,
      conditions: [],
    }));
    await expect(withoutOptIn.resolve({ resolve } as any, source, {})).resolves.toBeUndefined();

    const withOptIn = createSharedSourceResolver(
      makeShared(['mf-test-suffix-match'], { allowNodeModulesSuffixMatch: true }),
      () => ({ root, conditions: [] })
    );
    await expect(withOptIn.resolve({ resolve } as any, source, {})).resolves.toBe(
      'mf-test-suffix-match'
    );
  });
});

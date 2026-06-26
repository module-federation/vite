import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import type { ModuleFederationOptions } from '../src/utils/normalizeModuleFederationOptions';
import { isRollupChunk } from './helpers/assertions';
import { buildFixture, FIXTURES } from './helpers/build';
import { findChunk, getAllChunkCode, parseManifest } from './helpers/matchers';

const SHARED_BASE_MF_OPTIONS = {
  name: 'sharedRemote',
  filename: 'remoteEntry.js',
  exposes: {
    './exposed': resolve(FIXTURES, 'shared-remote', 'exposed-module.js'),
  },
  dts: false,
} satisfies Partial<ModuleFederationOptions>;

describe('shared dependencies', () => {
  it('routes shared dep through loadShare()', async () => {
    const output = await buildFixture({
      fixture: 'shared-remote',
      mfOptions: { ...SHARED_BASE_MF_OPTIONS, shared: { 'mock-shared-dep': {} } },
    });
    const allCode = getAllChunkCode(output);
    expect(allCode).toContain('loadShare');
    expect(allCode).toContain('mock-shared-dep');
  });

  it('keeps remoteEntry free of eager loadShare imports', async () => {
    const output = await buildFixture({
      fixture: 'shared-remote',
      mfOptions: { ...SHARED_BASE_MF_OPTIONS, shared: { 'mock-shared-dep': {} } },
    });
    const remoteEntry = findChunk(output, 'remoteEntry');
    expect(remoteEntry).toBeDefined();
    expect(remoteEntry!.imports.some((file) => file.includes('__loadShare__'))).toBe(false);
    expect(remoteEntry!.code).not.toMatch(/^import .*__loadShare__/m);
    expect(remoteEntry!.code).not.toMatch(/^import .*virtualExposes/m);
  });

  it('writes singleton config into remoteEntry', async () => {
    const output = await buildFixture({
      fixture: 'shared-remote',
      mfOptions: {
        ...SHARED_BASE_MF_OPTIONS,
        shared: { 'mock-shared-dep': { singleton: true } },
      },
    });
    const localSharedImportMap = findChunk(output, 'localSharedImportMap');
    expect(localSharedImportMap).toBeDefined();
    // Vite minifies `true` to `!0`, so match either form
    expect(localSharedImportMap!.code).toContain('singleton: true');
  });

  it('writes requiredVersion into remoteEntry', async () => {
    const output = await buildFixture({
      fixture: 'shared-remote',
      mfOptions: {
        ...SHARED_BASE_MF_OPTIONS,
        shared: { 'mock-shared-dep': { requiredVersion: '^2.0.0' } },
      },
    });
    const localSharedImportMap = findChunk(output, 'localSharedImportMap');
    expect(localSharedImportMap).toBeDefined();
    expect(localSharedImportMap!.code).toContain('^2.0.0');
  });

  it('generates host-must-provide error when import is false', async () => {
    const output = await buildFixture({
      fixture: 'shared-remote',
      mfOptions: {
        ...SHARED_BASE_MF_OPTIONS,
        shared: { 'mock-shared-dep': { import: false } },
      },
    });
    const localSharedImportMap = findChunk(output, 'localSharedImportMap');
    expect(localSharedImportMap).toBeDefined();
    // virtualRemoteEntry.ts:52 — throw in importMap when import === false
    expect(localSharedImportMap!.code).toContain('must be provided by host');
    // virtualRemoteEntry.ts:94 — shareConfig includes import: false
    // Vite minifies `false` to `!1`, so match either form
    expect(localSharedImportMap!.code).toContain('import: false');
  });

  it('supports import:false named imports with runtime-registered host shares', async () => {
    const output = await buildFixture({
      fixture: 'shared-remote',
      mfOptions: {
        ...SHARED_BASE_MF_OPTIONS,
        shared: { 'mock-shared-dep': { import: false, singleton: true } },
      },
    });

    const allCode = getAllChunkCode(output);
    const remoteEntry = findChunk(output, 'remoteEntry');
    const loadShare = output.output
      .filter(isRollupChunk)
      .find(
        (chunk) =>
          chunk.code.includes('__mfReadSharedCache') &&
          chunk.code.includes('default:mock-shared-dep')
      );

    expect(remoteEntry).toBeDefined();
    expect(loadShare).toBeDefined();
    expect(allCode).toContain('const versions =');
    expect(allCode).toContain('[pkg]');
    expect(allCode).toContain('__mfSelectSharedProvider');
    expect(allCode).not.toContain('versions[Object.keys(versions)[0]]');
    expect(allCode).toContain('__mfReadSharedCache(__mfModuleCache.share');
    expect(allCode).toContain('__mfWriteSharedCache(__mfModuleCache.share');
    expect(allCode).not.toContain('initRes.loadShare(pkg');
    expect(loadShare!.code).toContain('initPromise.then');
    expect(loadShare!.code).toContain('default:mock-shared-dep');
    expect(loadShare!.code).toContain('mock-shared-dep');
    expect(loadShare!.code).toContain('init');
    expect(loadShare!.code).not.toContain('await initPromise');
    expect(allCode).not.toContain('from"mock-shared-dep"');
    expect(allCode).not.toContain('from "mock-shared-dep"');
  });

  it('includes shared deps in manifest', async () => {
    const output = await buildFixture({
      fixture: 'shared-remote',
      mfOptions: {
        ...SHARED_BASE_MF_OPTIONS,
        manifest: true,
        shared: { 'mock-shared-dep': {} },
      },
    });
    const manifest = parseManifest(output) as Record<string, unknown>;
    expect(manifest).toBeDefined();
    expect(manifest).toHaveProperty('shared');

    const shared = manifest.shared as Array<{ name: string; version: string }>;
    const sharedEntry = shared.find((s) => s.name === 'mock-shared-dep');
    expect(sharedEntry).toBeDefined();
    expect(sharedEntry!.version).toBeTruthy();
  });

  it('includes singleton in manifest shared entries', async () => {
    const output = await buildFixture({
      fixture: 'shared-remote',
      mfOptions: {
        ...SHARED_BASE_MF_OPTIONS,
        manifest: true,
        shared: { 'mock-shared-dep': { singleton: true } },
      },
    });
    const manifest = parseManifest(output) as Record<string, unknown>;
    expect(manifest).toBeDefined();

    const shared = manifest.shared as Array<{ name: string; singleton?: boolean }>;
    const sharedEntry = shared.find((s) => s.name === 'mock-shared-dep');
    expect(sharedEntry).toBeDefined();
    expect(sharedEntry?.singleton).toBe(true);
  });
});

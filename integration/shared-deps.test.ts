import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import type { ModuleFederationOptions } from '../src/utils/normalizeModuleFederationOptions';
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
      mfOptions: { ...SHARED_BASE_MF_OPTIONS, shared: { defu: {} } },
    });
    const allCode = getAllChunkCode(output);
    expect(allCode).toContain('loadShare');
    expect(allCode).toContain('defu');
  });

  it('keeps remoteEntry free of eager loadShare imports', async () => {
    const output = await buildFixture({
      fixture: 'shared-remote',
      mfOptions: { ...SHARED_BASE_MF_OPTIONS, shared: { defu: {} } },
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
        shared: { defu: { singleton: true } },
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
        shared: { defu: { requiredVersion: '^6.0.0' } },
      },
    });
    const localSharedImportMap = findChunk(output, 'localSharedImportMap');
    expect(localSharedImportMap).toBeDefined();
    expect(localSharedImportMap!.code).toContain('^6.0.0');
  });

  it('generates host-must-provide error when import is false', async () => {
    const output = await buildFixture({
      fixture: 'shared-remote',
      mfOptions: {
        ...SHARED_BASE_MF_OPTIONS,
        shared: { defu: { import: false } },
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

  it('includes shared deps in manifest', async () => {
    const output = await buildFixture({
      fixture: 'shared-remote',
      mfOptions: {
        ...SHARED_BASE_MF_OPTIONS,
        manifest: true,
        shared: { defu: {} },
      },
    });
    const manifest = parseManifest(output) as Record<string, unknown>;
    expect(manifest).toBeDefined();
    expect(manifest).toHaveProperty('shared');

    const shared = manifest.shared as Array<{ name: string; version: string }>;
    const defuEntry = shared.find((s) => s.name === 'defu');
    expect(defuEntry).toBeDefined();
    expect(defuEntry!.version).toBeTruthy();
  });

  it('includes singleton in manifest shared entries', async () => {
    const output = await buildFixture({
      fixture: 'shared-remote',
      mfOptions: {
        ...SHARED_BASE_MF_OPTIONS,
        manifest: true,
        shared: { defu: { singleton: true } },
      },
    });
    const manifest = parseManifest(output) as Record<string, unknown>;
    expect(manifest).toBeDefined();

    const shared = manifest.shared as Array<{ name: string; singleton?: boolean }>;
    const defuEntry = shared.find((s) => s.name === 'defu');
    expect(defuEntry).toBeDefined();
    expect(defuEntry?.singleton).toBe(true);
  });
});

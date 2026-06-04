import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import type { ModuleFederationOptions } from '../src/utils/normalizeModuleFederationOptions';
import { buildFixture, FIXTURES } from './helpers/build';
import { isRollupChunk } from './helpers/assertions';
import { findChunk, getAllChunkCode, getChunkNames } from './helpers/matchers';

const ISOLATION_MF_OPTIONS = {
  name: 'scheduler',
  filename: 'remoteEntry.js',
  exposes: {
    './shared': resolve(FIXTURES, 'shared-remote', 'exposed-module.js'),
  },
  shared: {
    pathe: {},
  },
  dts: false,
} satisfies Partial<ModuleFederationOptions>;

describe('remote entry isolation', () => {
  it('keeps hostInit and remoteEntry isolated from shared wrapper chunks', async () => {
    const output = await buildFixture({
      fixture: 'shared-remote',
      mfOptions: ISOLATION_MF_OPTIONS,
    });

    const remoteEntry = findChunk(output, 'remoteEntry');
    const remoteEntryImpl = output.output
      .filter(isRollupChunk)
      .find((chunk) => /(?:const|var) mfName\s*=\s*["']scheduler["']/.test(chunk.code));
    const hostInit = findChunk(output, 'hostInit');
    const localSharedImportMap = findChunk(output, 'localSharedImportMap');
    const virtualExposes = findChunk(output, 'virtualExposes');
    const allCode = getAllChunkCode(output);

    expect(remoteEntry).toBeDefined();
    expect(remoteEntryImpl).toBeDefined();
    expect(hostInit).toBeDefined();
    expect(localSharedImportMap).toBeDefined();
    expect(virtualExposes).toBeDefined();

    const chunkNames = getChunkNames(output);
    expect(chunkNames.some((name) => name.includes('__loadShare__'))).toBe(true);
    expect(chunkNames.some((name) => name.includes('localSharedImportMap'))).toBe(true);

    expect(allCode).toContain('localSharedImportMap');
    expect(allCode).toContain('virtualExposes');
    expect(remoteEntry!.code).not.toContain('__vite__mapDeps');
    expect(remoteEntry!.code).not.toMatch(/import\{_ as \w+\}from["']\.\/assets\/.*TreeLoader/);
    expect(remoteEntry!.code).not.toMatch(/import["']\.\/assets\/.*__loadShare__/);
    expect(remoteEntry!.code).not.toMatch(/import["']\.\/assets\/.*localSharedImportMap/);
    expect(remoteEntry!.code).not.toMatch(/import["']\.\/assets\/.*virtualExposes/);
    expect(remoteEntryImpl!.code).toMatch(/(?:const|var) mfName\s*=\s*["']scheduler["']/);
    expect(remoteEntryImpl!.code).toMatch(/name:\s*mfName/);
    expect(allCode).toContain('__mfe_internal__scheduler');
    expect(localSharedImportMap!.code).toMatch(/from:\s*["']scheduler["']/);

    expect(localSharedImportMap!.code).not.toContain('__vite__mapDeps');
    expect(localSharedImportMap!.code).not.toContain('remoteEntry.js');
    expect(localSharedImportMap!.code).not.toMatch(/import["']\.\/.*__loadShare__/);

    expect(virtualExposes!.code).not.toContain('__vite__mapDeps');
    expect(virtualExposes!.code).not.toMatch(/import["']\.\/.*__loadShare__/);

    expect(hostInit!.code).not.toContain('__loadShare__');
    expect(hostInit!.code).not.toContain('__vite__mapDeps');
    expect(hostInit!.code).not.toContain('localSharedImportMap');
    expect(hostInit!.code).toContain('__mf_module_cache__');
    expect(hostInit!.code).not.toContain('virtualExposes');
  });
});

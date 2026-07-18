import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import type { ModuleFederationOptions } from '../src/utils/normalizeModuleFederationOptions';
import { buildFixture, FIXTURES } from './helpers/build';
import { getAllChunkCode, parseManifest } from './helpers/matchers';

const REMOTE_BASE = {
  name: 'basicRemote',
  filename: 'remoteEntry.js',
  exposes: {
    './exposed': resolve(FIXTURES, 'basic-remote', 'exposed-module.js'),
  },
  manifest: true,
  dts: false,
} satisfies Partial<ModuleFederationOptions>;

function totalJsCodeSize(code: string): number {
  return code.length;
}

describe('experiments.externalRuntime', () => {
  it('rewrites runtime-core to the host global and shrinks the remote bundle', async () => {
    const baseline = await buildFixture({
      fixture: 'basic-remote',
      mfOptions: REMOTE_BASE,
    });
    const externalized = await buildFixture({
      fixture: 'basic-remote',
      mfOptions: {
        ...REMOTE_BASE,
        experiments: { externalRuntime: true },
      },
    });

    const baselineCode = getAllChunkCode(baseline);
    const externalizedCode = getAllChunkCode(externalized);

    expect(externalizedCode).toContain('globalThis._FEDERATION_RUNTIME_CORE');
    expect(externalizedCode).toContain('experiments.externalRuntime is enabled');
    // Baseline still inlines runtime-core (no global shim).
    expect(baselineCode).not.toContain('globalThis._FEDERATION_RUNTIME_CORE');
    expect(totalJsCodeSize(externalizedCode)).toBeLessThan(totalJsCodeSize(baselineCode));

    const manifest = parseManifest(externalized) as Record<string, unknown>;
    expect(manifest).toBeDefined();
    expect(manifest).toHaveProperty('exposes');
    expect(Array.isArray(manifest.exposes)).toBe(true);
    expect((manifest.exposes as unknown[]).length).toBeGreaterThanOrEqual(1);
    expect(manifest).toHaveProperty('metaData');
  });

  it('rejects provideExternalRuntime on containers that expose modules', async () => {
    await expect(
      buildFixture({
        fixture: 'basic-remote',
        mfOptions: {
          ...REMOTE_BASE,
          experiments: { provideExternalRuntime: true },
        },
      })
    ).rejects.toThrow(
      /You can only set provideExternalRuntime: true in pure consumer which not expose modules/
    );
  });
});

describe('experiments.provideExternalRuntime', () => {
  it('injects the runtime-core provider plugin into a pure consumer build', async () => {
    const output = await buildFixture({
      fixture: 'basic-host',
      mfOptions: {
        name: 'basicHost',
        filename: 'remoteEntry.js',
        remotes: {
          remote1: {
            type: 'module',
            name: 'remote1',
            entry: 'http://localhost:5176/remoteEntry.js',
          },
        },
        manifest: true,
        dts: false,
        experiments: { provideExternalRuntime: true },
      },
    });

    const allCode = getAllChunkCode(output);
    expect(allCode).toMatch(/inject-external-runtime-core-plugin|_FEDERATION_RUNTIME_CORE/);

    const manifest = parseManifest(output) as Record<string, unknown>;
    expect(manifest).toBeDefined();
    expect(manifest).toHaveProperty('metaData');
  });
});

import defu from 'defu';
import { resolve } from 'path';
import { build, Rollup, UserConfig as ViteUserConfig } from 'vite';
import { expect } from 'vitest';
import { federation } from '../../src/index';
import type { ModuleFederationOptions } from '../../src/utils/normalizeModuleFederationOptions';

export const FIXTURES = resolve(__dirname, '../fixtures');

export interface BuildFixtureOptions {
  /**
   * @default 'basic-remote'
   */
  fixture?: string;
  mfOptions?: Partial<ModuleFederationOptions>;
  viteConfig?: Partial<ViteUserConfig>;
}

export async function buildFixture(opts?: BuildFixtureOptions): Promise<Rollup.RollupOutput> {
  const { fixture = 'basic-remote', mfOptions, viteConfig } = opts ?? {};

  const defaultMfOptions = {
    name: 'basicRemote',
    filename: 'remoteEntry.js',
    exposes: {},
    shared: {},
    dts: false,
  } satisfies Parameters<typeof federation>[0];

  // defu(overrides, defaults) — first arg wins for any key it provides
  const mergedMfOptions = defu(mfOptions, defaultMfOptions);

  const defaultViteConfig: ViteUserConfig = {
    root: resolve(FIXTURES, fixture),
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      target: 'chrome89',
    },
  };

  const mergedViteConfig = defu(viteConfig, defaultViteConfig);

  const result = await build({
    ...mergedViteConfig,
    plugins: [federation(mergedMfOptions)],
  });

  // Vite returns RollupOutput[] only with multiple rollupOptions.output entries.
  // Our test configs should never produce that — fail fast if they do.
  expect(Array.isArray(result), 'Expected a single RollupOutput, not an array').toBe(false);
  return result as Rollup.RollupOutput;
}

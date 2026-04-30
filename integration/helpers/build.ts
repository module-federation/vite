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

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function mergeDefaults<T extends object>(overrides: Partial<T> | undefined, defaults: T): T {
  const merged: PlainObject = { ...(defaults as PlainObject) };

  for (const [key, value] of Object.entries((overrides ?? {}) as PlainObject)) {
    if (value === undefined || value === null) {
      continue;
    }

    const defaultValue = merged[key];
    merged[key] =
      isPlainObject(value) && isPlainObject(defaultValue)
        ? mergeDefaults(value, defaultValue)
        : value;
  }

  return merged as T;
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

  const mergedMfOptions = mergeDefaults(mfOptions, defaultMfOptions);

  const defaultViteConfig: ViteUserConfig = {
    root: resolve(FIXTURES, fixture),
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      target: 'chrome89',
    },
  };

  const mergedViteConfig = mergeDefaults(viteConfig, defaultViteConfig);

  const result = await build({
    ...mergedViteConfig,
    plugins: [federation(mergedMfOptions)],
  });

  // Vite returns RollupOutput[] only with multiple rollupOptions.output entries.
  // Our test configs should never produce that — fail fast if they do.
  expect(Array.isArray(result), 'Expected a single RollupOutput, not an array').toBe(false);
  return result as Rollup.RollupOutput;
}

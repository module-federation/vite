import defu from 'defu';
import { resolve } from 'path';
import { build, Rollup } from 'vite';
import { describe, expect, it } from 'vitest';
import { federation } from '../src/index';
import { findAsset, findChunk, getChunkNames } from './helpers/matchers';

const FIXTURES = resolve(__dirname, 'fixtures');
const BASIC_REMOTE = resolve(FIXTURES, 'basic-remote');

async function buildFixture(optionsOverrides?: Partial<Parameters<typeof federation>[0]>) {
  const defaultOptions = {
    name: 'basicRemote',
    filename: 'remoteEntry.js',
    exposes: {
      './exposed': resolve(BASIC_REMOTE, 'exposed-module.js'),
    },
    shared: {},
    dts: false,
  } satisfies Parameters<typeof federation>[0];

  const mfOptions = defu(defaultOptions, optionsOverrides);

  const result = await build({
    root: BASIC_REMOTE,
    logLevel: 'silent',
    plugins: [federation(mfOptions)],
    build: {
      write: false,
      target: 'chrome89',
    },
  });

  // Vite returns RollupOutput[] only with multiple rollupOptions.output entries.
  // Our test configs should never produce that — fail fast if they do.
  expect(Array.isArray(result), 'E  xpected a single RollupOutput, not an array').toBe(false);
  return result as Rollup.RollupOutput;
}

describe('build', () => {
  describe('remote', () => {
    it('produces a remoteEntry chunk', async () => {
      const output = await buildFixture();
      const chunks = getChunkNames(output);
      expect(chunks.some((name) => name.includes('remoteEntry'))).toBe(true);
    });

    it('remoteEntry contains federation runtime init with correct name', async () => {
      const output = await buildFixture();
      const remoteEntry = findChunk(output, 'remoteEntry');
      expect(remoteEntry).toBeDefined();
      expect(remoteEntry!.code).toContain('basicRemote');
      expect(remoteEntry!.code).toContain('moduleCache');
    });

    it('exposed module content is included in output', async () => {
      const output = await buildFixture();
      const allCode = output.output
        .filter((o): o is Rollup.OutputChunk => o.type === 'chunk')
        .map((c) => c.code)
        .join('\n');

      expect(allCode).toContain('Hello');
    });

    it('generates mf-manifest.json when manifest is enabled', async () => {
      const manifestOutput = await buildFixture({
        manifest: true,
      });

      const manifest = findAsset(manifestOutput, 'mf-manifest.json');
      expect(manifest).toBeDefined();

      const parsed = JSON.parse(manifest!.source as string);
      expect(parsed).toHaveProperty('exposes');
    });
  });
});

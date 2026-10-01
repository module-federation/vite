import { resolve } from 'path';
import type { Rollup } from 'vite';
import { describe, expect, it } from 'vitest';
import { buildFixture, FIXTURES } from './helpers/build';
import { findAsset, getAllChunkCode } from './helpers/matchers';

const FIXTURE = 'importmap-remote';

async function buildImportMapRemote(): Promise<Rollup.RollupOutput> {
  return buildFixture({
    fixture: FIXTURE,
    mfOptions: {
      name: 'importMapRemote',
      exposes: {
        './Widget': resolve(FIXTURES, FIXTURE, 'exposed-widget.js'),
        './utils/helper': resolve(FIXTURES, FIXTURE, 'exposed-helper.js'),
      },
      shared: { 'shared-base': {} },
      experiments: { importMap: true },
    },
  });
}

function entry(output: Rollup.RollupOutput, fileName: string): Rollup.OutputChunk | undefined {
  for (const item of output.output) {
    if (item.type === 'chunk' && item.isEntry && item.fileName === fileName) return item;
  }
  return undefined;
}

describe('experiments.importMap — remote build', () => {
  it('emits one fixed-name entry per expose with its exports intact', async () => {
    const output = await buildImportMapRemote();
    expect(entry(output, 'Widget.js')?.exports).toEqual(['Widget', 'sharedInstance']);
    expect(entry(output, 'utils/helper.js')?.exports).toEqual(['helper']);
  });

  it('keeps shared dependencies as bare imports for the host import map', async () => {
    const widget = entry(await buildImportMapRemote(), 'Widget.js');
    expect(widget?.imports).toContain('shared-base');
    expect(widget?.code).toMatch(/from\s*["']shared-base["']/);
  });

  it('writes an import-map manifest mapping exposes to entry files', async () => {
    const manifest = findAsset(await buildImportMapRemote(), 'importmap-manifest.json');
    expect(manifest).toBeDefined();
    expect(JSON.parse(String(manifest!.source))).toEqual({
      name: 'importMapRemote',
      mode: 'importmap',
      publicPath: '/',
      exposes: { './Widget': 'Widget.js', './utils/helper': 'utils/helper.js' },
    });
  });

  it('emits no Module Federation runtime glue', async () => {
    const output = await buildImportMapRemote();
    const fileNames = output.output.map((item) => item.fileName).join('\n');
    expect(fileNames).not.toMatch(/__loadShare__|__prebuild__|remoteEntry|hostInit/);
    expect(getAllChunkCode(output)).not.toContain('@module-federation/runtime');
  });
});

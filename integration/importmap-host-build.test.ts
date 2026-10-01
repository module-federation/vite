import { resolve } from 'path';
import type { Rollup } from 'vite';
import { describe, expect, it } from 'vitest';
import { buildFixture, FIXTURES } from './helpers/build';
import { getAllChunkCode, getHtmlAsset } from './helpers/matchers';

const FIXTURE = 'importmap-host';
const vendor = (name: string) => resolve(FIXTURES, FIXTURE, 'vendor', name, 'index.js');

async function buildImportMapHost(): Promise<Rollup.RollupOutput> {
  return buildFixture({
    fixture: FIXTURE,
    mfOptions: {
      name: 'importMapHost',
      shared: { 'esm-dep': {}, 'esm-default-dep': {}, 'cjs-dep': {} },
      experiments: { importMap: true },
    },
    viteConfig: {
      resolve: {
        alias: {
          'esm-dep': vendor('esm-dep'),
          'esm-default-dep': vendor('esm-default-dep'),
          'cjs-dep': vendor('cjs-dep'),
        },
      },
    },
  });
}

function readImportMap(output: Rollup.RollupOutput): Record<string, string> {
  const html = String(getHtmlAsset(output)?.source ?? '');
  const match = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  expect(match, 'index.html should contain an import map').not.toBeNull();
  return JSON.parse(match![1]).imports;
}

function shareChunk(output: Rollup.RollupOutput, key: string): Rollup.OutputChunk | undefined {
  for (const item of output.output) {
    if (item.type === 'chunk' && item.facadeModuleId === `\0mf-importmap-share:${key}`) return item;
  }
  return undefined;
}

describe('experiments.importMap — host build', () => {
  it('maps every shared key to its emitted entry chunk', async () => {
    const output = await buildImportMapHost();
    const imports = readImportMap(output);

    for (const key of ['esm-dep', 'esm-default-dep', 'cjs-dep']) {
      const chunk = shareChunk(output, key);
      expect(chunk, `entry chunk for ${key}`).toBeDefined();
      expect(imports[key]).toBe(`/${chunk!.fileName}`);
    }
  });

  it('injects the import map before any module script', async () => {
    const html = String(getHtmlAsset(await buildImportMapHost())?.source ?? '');
    expect(html.indexOf('type="importmap"')).toBeGreaterThan(-1);
    expect(html.indexOf('type="importmap"')).toBeLessThan(html.indexOf('type="module"'));
  });

  it('forwards default only when the shared module has one', async () => {
    const output = await buildImportMapHost();
    expect(shareChunk(output, 'esm-dep')!.exports).toEqual(['named']);
    expect(shareChunk(output, 'esm-default-dep')!.exports.sort()).toEqual(['default', 'named']);
    expect(shareChunk(output, 'cjs-dep')!.exports).toContain('default');
  });

  it('emits no Module Federation runtime glue', async () => {
    const output = await buildImportMapHost();
    const code = getAllChunkCode(output);
    const fileNames = output.output.map((item) => item.fileName).join('\n');

    expect(fileNames).not.toMatch(/__loadShare__|__prebuild__|remoteEntry|hostInit/);
    expect(code).not.toContain('loadShare');
    expect(code).not.toContain('@module-federation/runtime');
  });
});

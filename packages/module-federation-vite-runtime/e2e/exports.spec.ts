import type { OutputAsset, OutputChunk, RollupOutput } from 'rollup';
import { build } from 'vite';
import { beforeAll, describe, expect, test } from 'vitest';

const expectedExports = ['init', 'loadRemote', 'loadShare'];

describe('@module-federation/vite-runtime', () => {
  let output: RollupOutput[];

  beforeAll(async () => {
    output = (await build()) as RollupOutput[];
  });

  test.each(expectedExports)('exports %s', (exportName) => {
    const index = getBuildEntrypoint(output, 'index.js');
    assertChunk(index);

    expect(index.exports).toContain(exportName);
  });

  test('excludes the eval call', () => {
    const index = getBuildEntrypoint(output, 'index.js');
    assertChunk(index);

    /*
    This might be a little fragile.  We probably want to regex this to ensure its strictly 'eval'
    instead of something that ends in eval(
    */
    expect(index.code).not.toContain('eval(');
  });
});

function getBuildEntrypoint(output: RollupOutput[], entrypoint: string) {
  for (const o of output) {
    const entry = o.output.find((o) => o.fileName === entrypoint);
    if (entry) {
      return entry;
    }
  }
}

function assertChunk(obj: OutputChunk | OutputAsset | undefined): asserts obj is OutputChunk {
  expect(obj).toBeDefined();
  expect(obj!.type).toBe('chunk');
}

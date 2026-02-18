import type { Rollup } from 'vite';
import { isRollupAsset, isRollupChunk } from './assertions';

export function getChunkNames(output: Rollup.RollupOutput) {
  return output.output.filter(isRollupChunk).map((c) => c.fileName);
}

export function findChunk(
  output: Rollup.RollupOutput,
  test: string | RegExp
): Rollup.OutputChunk | undefined {
  return output.output
    .filter(isRollupChunk)
    .find((o) => (typeof test === 'string' ? o.fileName.includes(test) : test.test(o.fileName)));
}

export function findAsset(
  output: Rollup.RollupOutput,
  test: string
): Rollup.OutputAsset | undefined {
  return output.output.filter(isRollupAsset).find((o) => o.fileName.includes(test));
}

export function getAllChunkCode(output: Rollup.RollupOutput): string {
  return output.output
    .filter(isRollupChunk)
    .map((c) => c.code)
    .join('\n');
}

export function getHtmlAsset(output: Rollup.RollupOutput): Rollup.OutputAsset | undefined {
  return output.output.filter(isRollupAsset).find((o) => o.fileName.endsWith('.html'));
}

export function parseManifest(output: Rollup.RollupOutput): object | undefined {
  const asset = findAsset(output, 'mf-manifest.json');
  if (!asset) return undefined;
  return JSON.parse(asset.source as string);
}

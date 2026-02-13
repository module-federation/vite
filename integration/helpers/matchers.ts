import type { Rollup } from 'vite';

export function getChunkNames(output: Rollup.RollupOutput) {
  return output.output
    .filter((o): o is Rollup.OutputChunk => o.type === 'chunk')
    .map((c) => c.fileName);
}

export function findChunk(output: Rollup.RollupOutput, test: string | RegExp) {
  return output.output.find(
    (o): o is Rollup.OutputChunk =>
      o.type === 'chunk' &&
      (typeof test === 'string' ? o.fileName.includes(test) : test.test(o.fileName))
  );
}

export function findAsset(output: Rollup.RollupOutput, test: string) {
  return output.output.find(
    (o): o is Rollup.OutputAsset => o.type === 'asset' && o.fileName.includes(test)
  );
}

import type { OutputAsset, OutputChunk, RollupOutput } from 'rollup';

export const isRollupChunk = (output: RollupOutput['output'][number]): output is OutputChunk =>
  output.type === 'chunk';

export const isRollupAsset = (output: RollupOutput['output'][number]): output is OutputAsset =>
  output.type === 'asset';

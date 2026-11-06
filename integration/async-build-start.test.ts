import { resolve } from 'path';
import { build, type Plugin, type Rollup } from 'vite';
import { describe, expect, it } from 'vitest';
import { federation } from '../src/index';
import { FIXTURES } from './helpers/build';

// Compilers such as @analogjs/vite-plugin-angular prepare their output in an async
// buildStart and only transform files correctly once it has finished.
function slowCompiler(): Plugin {
  let ready = false;
  return {
    name: 'slow-compiler',
    async buildStart() {
      await new Promise((r) => setTimeout(r, 200));
      ready = true;
    },
    transform(code, id) {
      if (id.endsWith('exposed-module.js') && !ready) return '';
    },
  };
}

describe('plugins with an async buildStart', () => {
  it('waits for them before emitting the federation chunks', async () => {
    const root = resolve(FIXTURES, 'basic-remote');
    const output = (await build({
      root,
      logLevel: 'silent',
      build: { write: false, minify: false, target: 'chrome89' },
      plugins: [
        slowCompiler(),
        federation({
          name: 'basicRemote',
          filename: 'remoteEntry.js',
          exposes: { './exposed': resolve(root, 'exposed-module.js') },
          dts: false,
        }),
      ],
    })) as Rollup.RollupOutput;
    const code = output.output
      .filter((item): item is Rollup.OutputChunk => item.type === 'chunk')
      .map((chunk) => chunk.code)
      .join('\n');
    expect(code).toContain('Hello, ');
  });
});

import { relative, resolve } from 'path';
import { version as viteVersion } from 'vite';
import { describe, expect, it } from 'vitest';
import { buildFixture, FIXTURES } from './helpers/build';
import { getAllChunkCode } from './helpers/matchers';

// The fixture root is not the working directory, so relative expose paths
// only resolve when they are resolved against Vite's root.
describe('relative exposes', () => {
  it('resolves relative expose paths against the Vite root', async () => {
    expect(process.cwd()).not.toBe(resolve(FIXTURES, 'basic-remote'));
    const output = await buildFixture({
      mfOptions: { exposes: { './exposed': './exposed-module.js' } },
    });
    const exposedChunk = output.output.find(
      (item) => item.type === 'chunk' && item.facadeModuleId?.endsWith('exposed-module.js')
    );
    expect(exposedChunk).toBeDefined();
    expect(getAllChunkCode(output)).not.toContain('./exposed-module.js');
  });

  // Before Vite 8 these resolved against the working directory; keep supporting them.
  it.skipIf(Number(viteVersion.split('.')[0]) >= 8)(
    'keeps resolving working-directory-relative expose paths',
    async () => {
      const source = `./${relative(process.cwd(), resolve(FIXTURES, 'basic-remote', 'exposed-module.js'))}`;
      const output = await buildFixture({ mfOptions: { exposes: { './exposed': source } } });
      expect(
        output.output.some(
          (item) => item.type === 'chunk' && item.facadeModuleId?.endsWith('exposed-module.js')
        )
      ).toBe(true);
    }
  );

  it('resolves relative expose paths against the Vite root in SSR builds', async () => {
    const output = await buildFixture({
      mfOptions: { exposes: { './exposed': './exposed-module.js' } },
      viteConfig: {
        build: {
          ssr: true,
          rollupOptions: { input: resolve(FIXTURES, 'basic-remote', 'entry.js') },
        },
      },
    });
    expect(output.output.some((item) => item.fileName === 'remoteEntry.ssr.js')).toBe(true);
    expect(
      output.output.some(
        (item) =>
          item.type === 'chunk' && item.moduleIds.some((id) => id.endsWith('exposed-module.js'))
      )
    ).toBe(true);
  });
});

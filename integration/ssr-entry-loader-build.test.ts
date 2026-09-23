import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Rollup } from 'vite';
import { version as viteVersion } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { federation } from '../src';
import { buildFixture, FIXTURES } from './helpers/build';
import { getAllChunkCode, getChunkNames } from './helpers/matchers';

// Integration tests run against src/ without building this package's lib/ export.
// Resolve the loader to its source so auto-injection is exercised in both builds.
vi.mock('../src/utils/packageUtils', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/packageUtils')>(
    '../src/utils/packageUtils'
  );
  return {
    ...actual,
    resolveImportPath(specifier: string) {
      if (specifier === '@module-federation/vite/ssrEntryLoader') {
        return fileURLToPath(new URL('../src/utils/ssrEntryLoader.ts', import.meta.url));
      }
      return actual.resolveImportPath(specifier);
    },
  };
});

const remotes = {
  remote1: {
    name: 'remote1',
    entry: 'http://localhost:3001/remoteEntry.js',
    type: 'module' as const,
  },
};

describe('SSR entry loader build output', () => {
  it('keeps the client output free of SSR loader imports and chunks', async () => {
    const output = await buildFixture({
      fixture: 'basic-host',
      mfOptions: { name: 'hostApp', remotes },
    });

    expect(getChunkNames(output).join('\n')).not.toMatch(/ssrEntryLoader|ssrVmStrategy/);
    expect(/ssrEntryLoader|ssrVmStrategy/.test(getAllChunkCode(output))).toBe(false);
  });

  it('retains the loader and VM strategy in the SSR output', async () => {
    const output = await buildFixture({
      fixture: 'basic-host',
      mfOptions: { name: 'hostApp', remotes },
      viteConfig: {
        build: {
          ssr: true,
          rollupOptions: { input: resolve(FIXTURES, 'basic-host', 'entry.js') },
        },
      },
    });

    const names = getChunkNames(output).join('\n');
    const code = getAllChunkCode(output);
    expect(names).toMatch(/ssrEntryLoader/);
    expect(names).toMatch(/ssrVmStrategy/);
    expect(code.includes('ssrEntryLoader-')).toBe(true);
    expect(code.includes('ssrVmStrategy-')).toBe(true);
  });

  it.runIf(Number(viteVersion.split('.')[0]) >= 8)(
    'separates client and SSR output in one app build',
    async () => {
      const { createBuilder } = await import('vite');
      for (const sharedConfigBuild of [false, true]) {
        const builder = await createBuilder({
          root: resolve(FIXTURES, 'basic-host'),
          logLevel: 'silent',
          builder: { sharedConfigBuild },
          plugins: [federation({ name: 'hostApp', remotes, dts: false })],
          build: { write: false, minify: false },
          environments: {
            client: {},
            ssr: {
              build: {
                ssr: true,
                rolldownOptions: { input: resolve(FIXTURES, 'basic-host', 'entry.js') },
              },
            },
          },
        });

        let client: Rollup.RollupOutput;
        let server: Rollup.RollupOutput;
        if (sharedConfigBuild) {
          server = (await builder.build(builder.environments.ssr)) as Rollup.RollupOutput;
          client = (await builder.build(builder.environments.client)) as Rollup.RollupOutput;
        } else {
          client = (await builder.build(builder.environments.client)) as Rollup.RollupOutput;
          server = (await builder.build(builder.environments.ssr)) as Rollup.RollupOutput;
        }
        expect(getChunkNames(client).join('\n')).not.toMatch(/ssrEntryLoader|ssrVmStrategy/);
        expect(/ssrEntryLoader|ssrVmStrategy/.test(getAllChunkCode(client))).toBe(false);
        expect(getChunkNames(server).join('\n')).toMatch(/ssrEntryLoader/);
        expect(getChunkNames(server).join('\n')).toMatch(/ssrVmStrategy/);
        expect(getAllChunkCode(server).includes('ssrEntryLoader-')).toBe(true);
      }
    }
  );
});

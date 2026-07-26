import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, type Plugin, type Rollup } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { federation } from '../src';

const outputDirs: string[] = [];
// Reuse an existing React 19 workspace package so this regression test does not
// need its own package.json, workspace entry, or lockfile importer.
const reactWorkspaceRoot = resolve(import.meta.dirname, '../examples/vite-vite/vite-remote');
const ssrEntryId = 'virtual:ssr-shared-exports-entry';
const resolvedSsrEntryId = `\0${ssrEntryId}`;

const ssrEntryPlugin: Plugin = {
  name: 'ssr-shared-exports-entry',
  resolveId(id) {
    if (id === ssrEntryId) return resolvedSsrEntryId;
  },
  load(id) {
    if (id === resolvedSsrEntryId) {
      return "export { renderToPipeableStream } from 'react-dom/server';";
    }
  },
};

afterEach(async () => {
  await Promise.all(outputDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('SSR shared conditional exports', () => {
  it('builds and executes the node export surface of react-dom/server', async () => {
    const outDir = await mkdtemp(resolve(reactWorkspaceRoot, '.mf-vite-ssr-'));
    outputDirs.push(outDir);

    const result = await build({
      root: reactWorkspaceRoot,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        ssrEntryPlugin,
        federation({
          name: 'ssrHost',
          shared: {
            'react-dom': { singleton: true },
          },
          dts: false,
        }),
      ],
      build: {
        ssr: true,
        outDir,
        write: true,
        minify: false,
        target: 'node20',
        rollupOptions: {
          input: ssrEntryId,
        },
      },
    });
    expect(Array.isArray(result), 'Expected a single RollupOutput, not an array').toBe(false);
    const output = result as Rollup.RollupOutput;

    const entryChunk = output.output.find(
      (item): item is Rollup.OutputChunk =>
        item.type === 'chunk' && item.isEntry && item.facadeModuleId === resolvedSsrEntryId
    );
    expect(entryChunk, 'Expected the virtual SSR entry chunk').toBeDefined();

    const serverEntry = await import(
      `${pathToFileURL(resolve(outDir, entryChunk!.fileName)).href}?test=${Date.now()}`
    );
    expect(serverEntry.renderToPipeableStream).toBeTypeOf('function');
  });
});

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInstance } from '@module-federation/runtime';
import { build, type InlineConfig } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { federation } from '../src';
import ssrEntryLoader, { revalidate } from '../src/utils/ssrEntryLoader';
import { serveDirectory, type StaticServer } from './helpers/browser';

const require = createRequire(
  new URL('../examples/vite-vite/vite-host/package.json', import.meta.url)
);
const React = require('react');
const { renderToString } = require('react-dom/server');
const { SourceTextModule } = (await import('node:vm')) as { SourceTextModule?: unknown };

describe.skipIf(!SourceTextModule)('VM linking with generated React remotes', () => {
  let root: string;
  let assets: StaticServer;
  let names: string[];

  beforeAll(async () => {
    root = await mkdtemp(path.join(import.meta.dirname, '.ssr-vm-reentrant-'));
    names = ['a', 'b'].map((name) => `${path.basename(root).replace(/\W/g, '_')}_${name}`);
    for (const [index, name] of names.entries()) {
      const remoteRoot = path.join(root, name);
      await mkdir(path.join(remoteRoot, 'node_modules'), { recursive: true });
      await symlink(
        path.dirname(require.resolve('react/package.json')),
        path.join(remoteRoot, 'node_modules/react'),
        'junction'
      );
      await writeFile(path.join(remoteRoot, 'package.json'), '{"type":"module"}');
      await writeFile(
        path.join(remoteRoot, 'index.html'),
        '<script type="module" src="/client.js"></script>'
      );
      await writeFile(path.join(remoteRoot, 'client.js'), 'export {};');
      await writeFile(
        path.join(remoteRoot, 'Widget.js'),
        `import React from 'react'; export const react = React;
         export default function Widget() { return React.createElement('div', null, '${index}-widget'); }`
      );
      const config = (ssr?: string): InlineConfig => ({
        root: remoteRoot,
        configFile: false,
        logLevel: 'silent',
        plugins: [
          federation({
            name,
            filename: 'remoteEntry.js',
            manifest: true,
            dts: false,
            exposes: { './Widget': './Widget.js' },
            shared: { react: { singleton: true, requiredVersion: `^${React.version}` } },
          }),
        ],
        build: { minify: false, emptyOutDir: false, target: 'node22', ssr },
      });
      await build(config());
      await build(config(path.join(remoteRoot, 'Widget.js')));
    }
    assets = await serveDirectory(root);
  }, 60_000);

  afterAll(async () => {
    await assets?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it.each([
    ['version-first', 'targeted'],
    ['loaded-first', 'full'],
    ['version-first', 'full'],
  ] as const)(
    'renders after a %s %s reset without losing host React',
    async (shareStrategy, reset) => {
      const host = createInstance({
        name: `${names[0]}_host_${shareStrategy}_${reset}`,
        shareStrategy,
        remotes: names.map((name) => ({
          name,
          entry: `${assets.origin}/${name}/dist/mf-manifest.json`,
        })),
        plugins: [
          ssrEntryLoader({
            strategy: 'vm',
            resolvedShared: { react: pathToFileURL(require.resolve('react')).href },
          }),
        ],
        shared: {
          react: {
            version: React.version,
            lib: () => React,
            shareConfig: { singleton: true, requiredVersion: `^${React.version}` },
          },
        },
      });
      const renderBoth = async () => {
        for (const [index, name] of names.entries()) {
          const widget = await host.loadRemote<{ default: () => unknown; react: unknown }>(
            `${name}/Widget`
          );
          expect(widget?.react).toBe(React);
          expect(renderToString(React.createElement(widget!.default))).toBe(
            `<div>${index}-widget</div>`
          );
        }
      };

      const factory = await host.loadShare('react');
      expect(factory && factory()).toBe(React);
      await renderBoth();
      revalidate(reset === 'targeted' ? names[0] : undefined);
      // The deadlock needs no redeploy: version-first share initialization loads
      // the other cleared container while the first widget is being linked.
      await renderBoth();
    },
    10_000
  );
});

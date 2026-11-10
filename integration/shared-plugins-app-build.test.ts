import { resolve } from 'node:path';
import type { Rollup } from 'vite';
import { version as viteVersion } from 'vite';
import { describe, expect, it } from 'vitest';
import { federation } from '../src';
import { FIXTURES } from './helpers/build';
import { findAsset, findChunk } from './helpers/matchers';

type FederationOptions = Parameters<typeof federation>[0];

// One plugin instance serves both environments, and the ssr environment's
// config is the last one it sees in configResolved.
async function buildClientOfSharedPluginsApp(fixture: string, mfOptions: FederationOptions) {
  const { createBuilder } = await import('vite');
  const root = resolve(FIXTURES, fixture);
  const builder = await createBuilder({
    root,
    logLevel: 'silent',
    builder: { sharedPlugins: true },
    plugins: [federation({ dts: false, ...mfOptions })],
    build: { write: false, minify: false },
    environments: {
      client: {},
      ssr: { build: { ssr: true, rolldownOptions: { input: resolve(root, 'entry.js') } } },
    },
  });
  return (await builder.build(builder.environments.client)) as Rollup.RollupOutput;
}

describe.runIf(Number(viteVersion.split('.')[0]) >= 8)(
  'client build of an app that shares plugins with its ssr environment',
  () => {
    it('warms the remote entry init chunks', async () => {
      const client = await buildClientOfSharedPluginsApp('basic-remote', {
        name: 'basicRemote',
        filename: 'remoteEntry.js',
        exposes: { './exposed': resolve(FIXTURES, 'basic-remote', 'exposed-module.js') },
      });

      expect(findChunk(client, 'remoteEntry')?.code).toContain('__mfWarmupPath');
    });

    it('waits for statically imported remotes under loaded-first', async () => {
      const client = await buildClientOfSharedPluginsApp('loaded-first-static-host', {
        name: 'hostApp',
        filename: 'remoteEntry.js',
        remotes: {
          remote1: {
            name: 'remote1',
            entry: 'http://localhost:4174/remoteEntry.js',
            type: 'module',
          },
        },
        shareStrategy: 'loaded-first',
        hostInitInjectLocation: 'html',
      });

      expect(String(findAsset(client, 'mf-entry-bootstrap')?.source)).toContain(
        'await Promise.all(__mfRemotePreloads);'
      );
    });
  }
);

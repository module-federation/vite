import { resolve } from 'path';
import { createBuilder, type Plugin, type Rollup } from 'vite';
import { describe, expect, it } from 'vitest';
import { federation } from '../src/index';
import { isRollupChunk } from './helpers/assertions';
import { FIXTURES } from './helpers/build';

function getAllChunkCode(output: Rollup.RollupOutput): string {
  return output.output
    .filter(isRollupChunk)
    .map((c) => c.code)
    .join('\n');
}

const MULTI_ENV_MF_OPTIONS = {
  name: 'multiEnvRemote',
  filename: 'remoteEntry.js',
  exposes: {
    './exposed': resolve(FIXTURES, 'multi-env', 'exposed-module.js'),
  },
  shared: { defu: {} },
  dts: false,
};

/**
 * Scope every plugin to the 'federation' environment only —
 * mirrors what @sanity/federation does with applyToEnvironment.
 */
function scopeToFederation(plugins: Plugin[]): Plugin[] {
  return plugins.map((p) => ({
    ...p,
    applyToEnvironment: (env: { name: string }) => env.name === 'federation',
  }));
}

async function buildMultiEnv(plugins: Plugin[]) {
  const builder = await createBuilder({
    root: resolve(FIXTURES, 'multi-env'),
    logLevel: 'silent',
    environments: {
      federation: {
        consumer: 'client',
        build: {
          write: false,
          minify: false,
          rollupOptions: {
            input: { entry: resolve(FIXTURES, 'multi-env', 'federation-entry.js') },
          },
        },
      },
      client: {
        consumer: 'client',
        build: {
          write: false,
          minify: false,
          rollupOptions: {
            input: { entry: resolve(FIXTURES, 'multi-env', 'client-entry.js') },
            preserveEntrySignatures: 'exports-only',
          },
        },
      },
    },
    builder: {},
    plugins,
  });

  // Build federation first (writes virtual module files as a side effect),
  // then client.
  const fedResult = (await builder.build(builder.environments.federation)) as Rollup.RollupOutput;
  const clientResult = (await builder.build(builder.environments.client)) as Rollup.RollupOutput;

  return { fedResult, clientResult };
}

/**
 * Tests that mf-vite works correctly inside a multi-environment Vite build.
 *
 * When a wrapper (e.g. @sanity/federation) scopes mf-vite plugins to a
 * single environment via `applyToEnvironment`, per-environment hooks like
 * `resolveId` and `load` only fire in that environment.  Global hooks
 * (`config`) still run everywhere, so shared-dep aliases registered there
 * would leak to all environments.
 *
 * The fix moves build-mode resolution from global aliases to per-environment
 * `resolveId` hooks.  These tests verify that the federation environment
 * still resolves shared deps through loadShare, while the client environment
 * resolves them normally with no interference.
 */
describe('multi-environment build', () => {
  it('shared dep resolution is scoped to the federation environment', async () => {
    const { fedResult, clientResult } = await buildMultiEnv(
      scopeToFederation(federation(MULTI_ENV_MF_OPTIONS))
    );

    // --- Federation environment ---
    // Shared deps should be routed through the MF runtime
    const fedCode = getAllChunkCode(fedResult);
    expect(fedCode).toContain('loadShare');

    // --- Client environment ---
    // Shared deps should resolve normally — no loadShare shim
    const clientCode = getAllChunkCode(clientResult);
    expect(clientCode).not.toContain('loadShare');
    // The actual defu code should be bundled directly
    expect(clientCode).toContain('createDefu');
  });

  it('named exports resolve correctly in the federation environment', async () => {
    const { fedResult } = await buildMultiEnv(scopeToFederation(federation(MULTI_ENV_MF_OPTIONS)));

    // The exposed module uses `import { createDefu } from 'defu'` — a named
    // import.  syntheticNamedExports must be set correctly for this to resolve.
    const fedCode = getAllChunkCode(fedResult);
    expect(fedCode).toContain('createDefu');
  });
});

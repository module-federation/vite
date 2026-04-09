import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { buildFixture, FIXTURES } from './helpers/build';
import { getAllChunkCode } from './helpers/matchers';

const SHARED_REMOTE_MF_OPTIONS = {
  shared: { defu: {} },
  exposes: {
    './exposed': resolve(FIXTURES, 'shared-remote', 'exposed-module.js'),
  },
};

const CJS_SHARED_MF_OPTIONS = {
  shared: { 'cjs-dep': {} },
  exposes: {
    './exposed': resolve(FIXTURES, 'shared-remote', 'exposed-cjs-module.js'),
  },
};

describe('ESM virtual modules', () => {
  it('resolves named imports from shared modules in build mode', async () => {
    const output = await buildFixture({
      fixture: 'shared-remote',
      mfOptions: SHARED_REMOTE_MF_OPTIONS,
    });
    const allCode = getAllChunkCode(output);
    // createDefu is a named export from defu — it should be present in the output
    expect(allCode).toContain('createDefu');
  });

  it('emits ESM import/export in build output for shared modules', async () => {
    const output = await buildFixture({
      fixture: 'shared-remote',
      mfOptions: SHARED_REMOTE_MF_OPTIONS,
    });
    const allCode = getAllChunkCode(output);
    // Build output should not contain CJS require() for the runtime init module
    expect(allCode).not.toMatch(/require\s*\(\s*["'].*runtimeInit/);
  });

  it('builds successfully when a shared dependency is CJS', async () => {
    const output = await buildFixture({
      fixture: 'shared-remote',
      mfOptions: CJS_SHARED_MF_OPTIONS,
      viteConfig: { resolve: { preserveSymlinks: true } },
    });
    const allCode = getAllChunkCode(output);
    // Shared package subpaths should also proxy through the runtime shim.
    expect(allCode).toContain('loadShare("cjs-dep/client"');
  });
});

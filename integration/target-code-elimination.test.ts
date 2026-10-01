import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { buildFixture, FIXTURES } from './helpers/build';
import { getAllChunkCode } from './helpers/matchers';

const BASIC_REMOTE_MF_OPTIONS = {
  exposes: {
    './exposed': resolve(FIXTURES, 'basic-remote', 'exposed-module.js'),
  },
};

describe('target-specific code elimination', () => {
  describe('target: web (default)', () => {
    it('excludes eval() from browser builds', async () => {
      const output = await buildFixture({ mfOptions: BASIC_REMOTE_MF_OPTIONS });
      const allCode = getAllChunkCode(output);
      expect(allCode).not.toMatch(/\beval\s*\(/);
    });
  });

  describe('target: node', () => {
    it('preserves Node.js script loading implementation', async () => {
      const output = await buildFixture({
        mfOptions: { ...BASIC_REMOTE_MF_OPTIONS, target: 'node' },
      });
      const allCode = getAllChunkCode(output);
      // Node builds keep loadScriptNode for remote entry loading
      expect(allCode).toMatch(/loadScriptNode/);
    });
  });
});

describe('runtime capability code elimination', () => {
  it('removes remote consumption internals when disableRemote is enabled', async () => {
    const output = await buildFixture({
      mfOptions: {
        ...BASIC_REMOTE_MF_OPTIONS,
        disableRemote: true,
      },
    });
    const allCode = getAllChunkCode(output);

    expect(allCode).toContain(
      'Remote loading is disabled by experiments.optimization.disableRemote.'
    );
    expect(allCode).not.toContain('beforeRegisterRemote');
  });

  it('removes shared dependency internals when disableShared is enabled', async () => {
    const output = await buildFixture({
      mfOptions: {
        ...BASIC_REMOTE_MF_OPTIONS,
        disableShared: true,
      },
    });
    const allCode = getAllChunkCode(output);

    expect(allCode).toContain(
      'Shared dependency loading is disabled by experiments.optimization.disableShared.'
    );
    expect(allCode).not.toContain('initContainerShareScopeMap');
  });

  it('removes snapshot plugins when disableSnapshot is enabled', async () => {
    const defaultOutput = await buildFixture({
      mfOptions: BASIC_REMOTE_MF_OPTIONS,
    });
    const optimizedOutput = await buildFixture({
      mfOptions: {
        ...BASIC_REMOTE_MF_OPTIONS,
        disableSnapshot: true,
      },
    });

    expect(getAllChunkCode(defaultOutput)).toContain('generatePreloadAssetsPlugin');
    expect(getAllChunkCode(optimizedOutput)).not.toContain(
      'generatePreloadAssetsPlugin'
    );
  });
});

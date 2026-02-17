import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { buildFixture, FIXTURES } from './helpers/build';
import { getAllChunkCode } from './helpers/matchers';

const BASIC_REMOTE_MF_OPTIONS = {
  exposes: {
    './exposed': resolve(FIXTURES, 'basic-remote', 'exposed-module.js'),
  },
};

describe('tree-shaking', () => {
  describe('target: web (default)', () => {
    it('excludes eval() from browser builds', async () => {
      const output = await buildFixture({ mfOptions: BASIC_REMOTE_MF_OPTIONS });
      const allCode = getAllChunkCode(output);
      expect(allCode).not.toMatch(/\beval\s*\(/);
    });

    it('excludes Node.js vm module usage from browser builds', async () => {
      const output = await buildFixture({ mfOptions: BASIC_REMOTE_MF_OPTIONS });
      const allCode = getAllChunkCode(output);
      expect(allCode).not.toContain('importNodeModule');
    });

    it('replaces Node.js script loaders with stubs', async () => {
      const output = await buildFixture({ mfOptions: BASIC_REMOTE_MF_OPTIONS });
      const allCode = getAllChunkCode(output);
      // The stub throws an error with this message when ENV_TARGET = 'web'
      expect(allCode).toContain('createScriptNode is disabled');
    });
  });

  describe('target: node', () => {
    it('preserves Node.js script loading implementation', async () => {
      const output = await buildFixture({
        mfOptions: { ...BASIC_REMOTE_MF_OPTIONS, target: 'node' },
      });
      const allCode = getAllChunkCode(output);
      // Node builds keep eval() for script loading
      expect(allCode).toMatch(/\beval\s*\(/);
    });
  });
});

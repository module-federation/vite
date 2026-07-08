import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import type { ModuleFederationOptions } from '../src/utils/normalizeModuleFederationOptions';
import { buildFixture, FIXTURES } from './helpers/build';
import { getAllChunkCode } from './helpers/matchers';

const REMOTE_DEPENDENCY_MF_OPTIONS = {
  name: 'classRemote',
  filename: 'remoteEntry.js',
  exposes: {
    './init': resolve(FIXTURES, 'nested-remote-class', 'exposed-init.js'),
  },
  remotes: {
    ckeditor5: {
      name: 'ckeditor5',
      entry: 'http://localhost:3002/remoteEntry.js',
      type: 'module',
    },
  },
  dts: false,
} satisfies Partial<ModuleFederationOptions>;

const TRANSITIVE_REMOTE_DEPENDENCY_MF_OPTIONS = {
  name: 'transitiveRemote',
  filename: 'remoteEntry.js',
  exposes: {
    './widget': resolve(FIXTURES, 'nested-remote-transitive', 'exposed-widget.js'),
  },
  remotes: {
    remoteA: {
      name: 'remoteA',
      entry: 'http://localhost:3001/remoteEntry.js',
      type: 'module',
    },
  },
  dts: false,
} satisfies Partial<ModuleFederationOptions>;

describe('remote dependency pending', () => {
  it('waits at expose loading for nested remote named imports without TLA', async () => {
    const output = await buildFixture({
      fixture: 'nested-remote-class',
      mfOptions: REMOTE_DEPENDENCY_MF_OPTIONS,
    });

    const allCode = getAllChunkCode(output);

    expect(allCode).toMatch(/\b(?:const|var)\s+\{\s*View\s*\}\s*=\s*exportModule/);
    expect(allCode).not.toContain('const pendingPrototype = {};');
    expect(allCode).toContain('__loadRemote__ckeditor5__loadRemote__');
    expect(allCode).toContain('const dependencyPending = importModule && importModule.__mf_remote_dependency_pending;');
    expect(allCode).toContain('await dependencyPending;');
    expect(allCode).toMatch(
      /\b(?:const|var)\s+__mf_remote_dependency_pending\s*=\s*Promise\.all\(\[__mf_remote_pending\]\)/
    );
    expect(allCode).not.toMatch(
      /\b(?:const|var)\s+__mf_remote_dependency_pending\s*=\s*await\b/
    );
  });

  it('preloads nested remotes discovered through local transitive imports', async () => {
    const output = await buildFixture({
      fixture: 'nested-remote-transitive',
      mfOptions: TRANSITIVE_REMOTE_DEPENDENCY_MF_OPTIONS,
    });

    const allCode = getAllChunkCode(output);

    expect(allCode).toContain('__loadRemote__remoteA_mf_1_shared_mf_1_helpers__loadRemote__');
    expect(allCode).toContain('loadRemote("remoteA/shared/helpers")');
    expect(allCode).toMatch(
      /await Promise\.all\(\[.*remoteA_mf_1_shared_mf_1_helpers__loadRemote__.*__mf_remote_pending/
    );
    expect(allCode).toMatch(/\b(?:const|var)\s+\{\s*helper(?:\s*:\s*helper)?\s*\}\s*=/);
    expect(allCode).toContain('Promise.all([__mf_remote_pending]);');
  });
});

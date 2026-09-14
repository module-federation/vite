import { describe, expect, it, vi } from 'vitest';
import type { ModuleFederationOptions } from '../src/utils/normalizeModuleFederationOptions';
import { buildFixture } from './helpers/build';

describe('multi-instance parse barrier', () => {
  it('builds without stalling on moduleParseIdleTimeout when two federation() instances share a config', async () => {
    // Before #1285 each instance tracked its sibling's remote entry and both
    // stalled until the idle timeout warned.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await buildFixture({
        fixture: 'basic-remote',
        mfOptions: [
          {
            name: 'host',
            filename: 'remoteEntry-a.js',
            moduleParseIdleTimeout: 1,
            dts: false,
            remotes: {
              remote_a: {
                type: 'module',
                name: 'remote_a',
                entry: 'https://example.com/remote-a/remoteEntry.js',
              },
            },
          },
          {
            name: 'host',
            filename: 'remoteEntry-b.js',
            moduleParseIdleTimeout: 1,
            dts: false,
            remotes: {
              remote_b: {
                type: 'module',
                name: 'remote_b',
                entry: 'https://example.com/remote-b/remoteEntry.js',
              },
            },
          },
        ] satisfies Partial<ModuleFederationOptions>[],
      });

      const idleTimeoutWarnings = warn.mock.calls.filter(([message]) =>
        typeof message === 'string' ? message.includes('moduleParseIdleTimeout') : false
      );
      expect(idleTimeoutWarnings).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });
});

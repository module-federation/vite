import { describe, expect, it, vi } from 'vitest';
import type { ModuleFederationOptions } from '../src/utils/normalizeModuleFederationOptions';
import { buildFixture } from './helpers/build';

describe('multi-instance parse barrier', () => {
  it('builds without stalling on moduleParseIdleTimeout when two federation() instances share a config', async () => {
    // Regression: every federation() instance emits its own remote entry
    // chunk, and pluginProxyRemoteEntry's load hook waits on that instance's
    // parsePromise to generate it. Before the fix, an instance's exclude
    // function recognized only its own remoteEntryId, so it kept tracking the
    // *other* instance's remote entry id in its parseStartSet — which never
    // reaches parseEndSet, since generating it is exactly what's blocked on
    // this parsePromise. Two instances therefore waited on each other forever
    // and only ever finished once moduleParseIdleTimeout forced a resolve.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await buildFixture({
        fixture: 'basic-remote',
        mfOptions: {
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
        } satisfies Partial<ModuleFederationOptions>,
        extraMfOptions: [
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
          } satisfies Partial<ModuleFederationOptions>,
        ],
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

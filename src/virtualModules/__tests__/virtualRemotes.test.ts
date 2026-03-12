import { describe, expect, it } from 'vitest';
import { normalizeModuleFederationOptions } from '../../utils/normalizeModuleFederationOptions';
import { generateRemotes } from '../virtualRemotes';

describe('generateRemotes', () => {
  it('awaits the loadRemote result directly in build output', () => {
    normalizeModuleFederationOptions({
      name: 'host-app',
      filename: 'remoteEntry.js',
      exposes: {},
      remotes: {},
      shared: {},
    });

    const code = generateRemotes('remote/Button', 'build', false);

    expect(code).toContain(
      'const res = initPromise.then(runtime => runtime.loadRemote("remote/Button"))'
    );
    expect(code).toContain('const exportModule = await res');
    expect(code).not.toContain('const exportModule = await initPromise.then(_ => res)');
  });
});

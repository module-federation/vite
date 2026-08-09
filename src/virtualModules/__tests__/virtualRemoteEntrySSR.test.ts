import { describe, expect, it } from 'vitest';
import { getDefaultMockOptions } from '../../utils/__tests__/helpers';
import { generateRemoteEntrySSR, getRemoteEntrySSRId } from '../virtualRemoteEntrySSR';

describe('virtualRemoteEntrySSR', () => {
  it('uses public runtime name while keeping internal virtual IDs', () => {
    const options = getDefaultMockOptions({
      internalName: '__mfe_internal__remote',
      name: 'remote',
      filename: 'remoteEntry.js',
      shareStrategy: 'version-first',
    });

    const code = generateRemoteEntrySSR(options);

    expect(code).toContain('name: "remote"');
    expect(code).toContain('const initToken = { from: "remote" }');
    expect(code).toContain(
      'import("virtual:mf-exposes-ssr:__mfe_internal__remote__remoteEntry_js")'
    );
    expect(getRemoteEntrySSRId(options)).toBe(
      'virtual:mf-REMOTE_ENTRY_SSR_ID:__mfe_internal__remote__remoteEntry_js'
    );
    expect(code).not.toContain('name: "__mfe_internal__remote"');
    expect(code).not.toContain('from: "__mfe_internal__remote"');
  });

  it('initializes all configured SSR provider share scopes', () => {
    const options = getDefaultMockOptions({
      name: 'remote',
      shareScope: ['default', 'scope1'],
      shareStrategy: 'version-first',
    } as any);

    const code = generateRemoteEntrySSR(options);

    expect(code).toContain('const shareScopeNames = Array.isArray(["default","scope1"])');
    expect(code).toContain('for (const scopeName of shareScopeNames)');
    expect(code).toContain("console.error('[Module Federation SSR]', e);");
    expect(code).toContain('initRes.initShareScopeMap(scopeName, scopeShare)');
    expect(code).toContain('initRes.initializeSharing(scopeName');
  });

  it('caches host-provided SSR singletons during container init', () => {
    const options = getDefaultMockOptions({
      name: 'remote',
      shared: {
        react: {
          name: 'react',
          version: '19.0.0',
          scope: 'default',
          from: '',
          shareConfig: { singleton: true, requiredVersion: '^19.0.0' },
        },
        lodash: {
          name: 'lodash',
          version: '4.17.21',
          scope: 'default',
          from: '',
          shareConfig: { singleton: false, requiredVersion: '^4.17.21' },
        },
      },
    } as any);

    const code = generateRemoteEntrySSR(options);

    expect(code).toContain('const sharedSingletons = {"react"');
    expect(code).not.toContain('"lodash"');
    expect(code).toContain('const factory = await initRes.loadShare(pkg');
    expect(code).toContain("cache[scopeName + ':' + pkg] ??= module");
    expect(code.slice(0, code.indexOf('async function'))).not.toContain('await ');
  });
});

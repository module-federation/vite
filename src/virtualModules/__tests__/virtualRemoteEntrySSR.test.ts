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
});

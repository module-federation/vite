import { describe, expect, it } from 'vitest';
import { exposeEntryName, remoteSpecifier, sharedKeyOwning } from '../importMapSpecifiers';

describe('importMap specifiers', () => {
  it('maps expose keys to fixed entry names', () => {
    expect(exposeEntryName('.')).toBe('index');
    expect(exposeEntryName('./Button')).toBe('Button');
    expect(exposeEntryName('./forms/Input')).toBe('forms/Input');
  });

  it('builds the bare specifier the host maps for a remote expose', () => {
    expect(remoteSpecifier('remote', '.')).toBe('remote');
    expect(remoteSpecifier('remote', './Button')).toBe('remote/Button');
    expect(remoteSpecifier('@scope/remote', './forms/Input')).toBe('@scope/remote/forms/Input');
  });

  it('finds the longest shared key owning a specifier', () => {
    const keys = ['lodash-es', '@scope/lib', '@scope/lib/sub'];
    expect(sharedKeyOwning('lodash-es', keys)).toBe('lodash-es');
    expect(sharedKeyOwning('lodash-es/debounce', keys)).toBe('lodash-es');
    expect(sharedKeyOwning('@scope/lib/sub/deep', keys)).toBe('@scope/lib/sub');
    expect(sharedKeyOwning('lodash', keys)).toBeUndefined();
    expect(sharedKeyOwning('lodash-esx', keys)).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import {
  getSsrRemoteEntryFileName,
  resolveDevHashEntryFileName,
  resolveSsrRemoteEntryFileName,
} from '../remoteEntryFileName';

describe('resolveDevHashEntryFileName', () => {
  it('strips hash placeholders for stable serve names', () => {
    expect(resolveDevHashEntryFileName('remoteEntry-[hash]')).toBe('remoteEntry.js');
    expect(resolveDevHashEntryFileName('remoteEntry-[hash].js')).toBe('remoteEntry.js');
    expect(resolveDevHashEntryFileName('remote-entry-[hash:8].js')).toBe('remote-entry.js');
  });

  it('leaves non-hash filenames unchanged', () => {
    expect(resolveDevHashEntryFileName('remoteEntry.js')).toBe('remoteEntry.js');
  });
});

describe('getSsrRemoteEntryFileName', () => {
  it('inserts .ssr before the extension', () => {
    expect(getSsrRemoteEntryFileName('remoteEntry.js')).toBe('remoteEntry.ssr.js');
    expect(getSsrRemoteEntryFileName('remoteEntry-abc.js')).toBe('remoteEntry-abc.ssr.js');
  });
});

describe('resolveSsrRemoteEntryFileName', () => {
  it('strips hash placeholders to a stable SSR companion', () => {
    expect(resolveSsrRemoteEntryFileName('remoteEntry-[hash]')).toBe('remoteEntry.ssr.js');
    expect(resolveSsrRemoteEntryFileName('remoteEntry-[hash].js')).toBe('remoteEntry.ssr.js');
  });

  it('does not derive hashed SSR names from browser chunks when config uses [hash]', () => {
    expect(resolveSsrRemoteEntryFileName('remoteEntry-[hash]', 'remoteEntry-deadbeef.js')).toBe(
      'remoteEntry.ssr.js'
    );
  });

  it('derives SSR name from an emitted browser chunk for non-hash configs', () => {
    expect(resolveSsrRemoteEntryFileName('remoteEntry.js', 'assets/remoteEntry.js')).toBe(
      'assets/remoteEntry.ssr.js'
    );
  });
});

import { describe, expect, it } from 'vitest';
import { getSsrCapabilities } from '../ssrCapabilities';

describe('getSsrCapabilities', () => {
  it('disables everything when there are no remotes', () => {
    expect(getSsrCapabilities(8, 'serve', false)).toEqual({
      enableSsrInitBootstrap: false,
      injectSsrEntryLoader: false,
    });
    expect(getSsrCapabilities(5, 'build', false)).toEqual({
      enableSsrInitBootstrap: false,
      injectSsrEntryLoader: false,
    });
  });

  it('enables SSR on Vite 8+ dev', () => {
    expect(getSsrCapabilities(8, 'serve', true)).toEqual({
      enableSsrInitBootstrap: true,
      injectSsrEntryLoader: true,
    });
  });

  it('disables SSR dev features on Vite 5–7 serve', () => {
    expect(getSsrCapabilities(7, 'serve', true)).toEqual({
      enableSsrInitBootstrap: false,
      injectSsrEntryLoader: false,
    });
  });

  it('enables SSR on build for older Vite majors', () => {
    expect(getSsrCapabilities(5, 'build', true)).toEqual({
      enableSsrInitBootstrap: true,
      injectSsrEntryLoader: true,
    });
  });
});

import { describe, expect, it } from 'vitest';
import { deriveMfHmrUrl, getMfHmrPath, matchesMfHmrUrl } from '../hmrUtils';

describe('hmrUtils', () => {
  it('derives an HMR url next to remoteEntry', () => {
    expect(deriveMfHmrUrl('http://localhost:4173/app/remoteEntry.js')).toBe(
      'http://localhost:4173/app/__mf_hmr'
    );
  });

  it('matches the HMR endpoint under a configured base', () => {
    expect(getMfHmrPath('/app/')).toBe('/app/__mf_hmr');
    expect(matchesMfHmrUrl('/app/__mf_hmr', '/app/')).toBe(true);
    expect(matchesMfHmrUrl('/__mf_hmr', '/app/')).toBe(true);
  });

  it('handles absolute base urls', () => {
    expect(getMfHmrPath('http://localhost:5176/testbase')).toBe('/testbase/__mf_hmr');
    expect(matchesMfHmrUrl('/testbase/__mf_hmr', 'http://localhost:5176/testbase')).toBe(true);
  });
});

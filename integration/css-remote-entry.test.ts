import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import type { ModuleFederationOptions } from '../src/utils/normalizeModuleFederationOptions';
import { buildFixture, FIXTURES } from './helpers/build';
import { findChunk } from './helpers/matchers';

const CSS_REMOTE_ENTRY_OPTIONS = {
  name: 'cssRemote',
  filename: 'remoteEntry.js',
  exposes: {
    './widget': resolve(FIXTURES, 'css-remote', 'exposed-module.js'),
  },
  bundleAllCSS: true,
  dts: false,
} satisfies Partial<ModuleFederationOptions>;

describe('css remote entry', () => {
  it('embeds CSS injection metadata into the direct remote-entry path', async () => {
    const output = await buildFixture({
      fixture: 'css-remote',
      mfOptions: CSS_REMOTE_ENTRY_OPTIONS,
    });

    const virtualExposes = findChunk(output, 'virtualExposes');
    expect(virtualExposes).toBeDefined();
    expect(virtualExposes!.code).toContain('injectCssAssets');
    expect(virtualExposes!.code).toContain('.css');
    expect(virtualExposes!.code).toContain('./widget');
  });
});

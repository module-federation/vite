import { describe, expect, it } from 'vitest';
import type { ModuleFederationOptions } from '../src/utils/normalizeModuleFederationOptions';
import { buildFixture } from './helpers/build';
import { findChunk, getAllChunkCode, getChunkNames, getHtmlAsset } from './helpers/matchers';

const HOST_BASE_MF_OPTIONS = {
  name: 'hostApp',
  filename: 'remoteEntry.js',
  remotes: {
    remote1: {
      name: 'remote1',
      entry: 'http://localhost:3001/remoteEntry.js',
      type: 'module',
    },
  },
  dts: false,
} satisfies Partial<ModuleFederationOptions>;

// The hostInit script is now an inline module that awaits the chunk's __tla
// to guarantee initPromise resolves before loadShare TLA chunks evaluate.
const hostInitChunkRegex = /<script\s+type="module">await import\("[^"]*hostInit[^"]*"\)/;

describe('host build', () => {
  it('transforms remote module imports into federation loadRemote() calls', async () => {
    const output = await buildFixture({
      fixture: 'basic-host',
      mfOptions: HOST_BASE_MF_OPTIONS,
    });
    const allCode = getAllChunkCode(output);
    expect(allCode).toContain('loadRemote');
    expect(allCode).toContain('remote1/Module');
  });

  it('adds federation bootstrap script to HTML <head> when hostInitInjectLocation is html', async () => {
    const output = await buildFixture({
      fixture: 'basic-host',
      mfOptions: { ...HOST_BASE_MF_OPTIONS, hostInitInjectLocation: 'html' },
    });
    const htmlAsset = getHtmlAsset(output);
    expect(htmlAsset).toBeDefined();
    // pluginAddEntry.generateBundle injects a <script> tag into <head> referencing
    // the hostInit chunk (content-hashed filename, e.g. "hostInit-abc123.js")
    expect(htmlAsset!.source as string).toMatch(hostInitChunkRegex);
  });

  it('does not add bootstrap script to HTML when hostInitInjectLocation is entry', async () => {
    const output = await buildFixture({
      fixture: 'basic-host',
      mfOptions: { ...HOST_BASE_MF_OPTIONS, hostInitInjectLocation: 'entry' },
    });
    const htmlAsset = getHtmlAsset(output);
    expect(htmlAsset).toBeDefined();
    // In entry mode, pluginAddEntry.transform prepends the federation bootstrap
    // import to entry modules instead of adding a script tag to the HTML
    expect(htmlAsset!.source as string).not.toMatch(hostInitChunkRegex);
    // The hostInit chunk is still emitted (federation init must still run),
    // but it's loaded through the module graph rather than an HTML script tag
    expect(getChunkNames(output).some((name) => name.includes('hostInit'))).toBe(true);
    expect(getAllChunkCode(output)).toContain('initializeSharing');
  });

  it('embeds configured federation name in remoteEntry chunk', async () => {
    const output = await buildFixture({
      fixture: 'basic-host',
      mfOptions: HOST_BASE_MF_OPTIONS,
    });
    const remoteEntry = findChunk(output, 'remoteEntry');
    expect(remoteEntry).toBeDefined();
    // virtualRemoteEntry.ts writes the federation name into the remoteEntry
    expect(remoteEntry!.code).toContain('hostApp');
  });
});

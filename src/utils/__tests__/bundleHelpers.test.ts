import { describe, expect, it } from 'vitest';
import { findRemoteEntryFile } from '../bundleHelpers';
import type { OutputBundleItem } from '../cssModuleHelpers';

const chunk = (fileName: string, name: string): OutputBundleItem => ({
  type: 'chunk',
  fileName,
  name,
  modules: {},
  dynamicImports: [],
});

describe('findRemoteEntryFile', () => {
  // An expose basenamed like the container gets the same chunk name; even emitted first,
  // it must not be picked as the remoteEntry — only the container exports `init`/`get`.
  // Both a camelCase `remoteEntry.js` and a kebab `remote-entry.js` filename collide.
  it.each(['remote-entry', 'remoteEntry'])(
    'returns the %s container, not a same-named expose chunk',
    (base) => {
      const filename = `${base}.js`;
      const exposeFile = `assets/${base}-abc123.js`;
      const bundle: Record<string, OutputBundleItem> = {
        [exposeFile]: chunk(exposeFile, base),
        [filename]: chunk(filename, base),
      };
      expect(findRemoteEntryFile(filename, bundle)).toBe(filename);
    }
  );

  it('returns the container when an unrelated expose is literally named `remoteEntry`', () => {
    // The matcher also has a hardcoded `name === 'remoteEntry'` branch; guard it for a
    // custom `filename` so a camelCase expose can't hijack the manifest.
    const bundle: Record<string, OutputBundleItem> = {
      'assets/remoteEntry-abc123.js': chunk('assets/remoteEntry-abc123.js', 'remoteEntry'),
      'mfEntry.js': chunk('mfEntry.js', 'mfEntry'),
    };
    expect(findRemoteEntryFile('mfEntry.js', bundle)).toBe('mfEntry.js');
  });

  it('falls back to the name match when no chunk equals the filename (hashed/dev)', () => {
    const bundle: Record<string, OutputBundleItem> = {
      'assets/remoteEntry-abc123.js': chunk('assets/remoteEntry-abc123.js', 'remoteEntry'),
    };
    expect(findRemoteEntryFile('remoteEntry.js', bundle)).toBe('assets/remoteEntry-abc123.js');
  });
});

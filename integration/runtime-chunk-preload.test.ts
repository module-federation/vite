import { describe, expect, it } from 'vitest';
import { buildFixture } from './helpers/build';
import { findChunk } from './helpers/matchers';

// The dependency list Vite's preload helper receives for `import(<target>)`.
function preloadDepsOf(importer: string, target: string): string[] {
  const files: string[] = JSON.parse(importer.match(/m\.f\|\|\(m\.f=(\[[^\]]*\])/)?.[1] ?? '[]');
  const call = new RegExp(
    `import\\("\\./${target}-[^"]+"\\)[^\\n]*__vite__mapDeps\\(\\[([\\d,]*)\\]\\)`
  ).exec(importer);
  return (call?.[1] ?? '')
    .split(',')
    .filter(Boolean)
    .map((index) => files[Number(index)]);
}

describe('modulepreload dependencies of a lazy chunk that imports a shared dependency', () => {
  it('keeps an application chunk named `dist`', async () => {
    const output = await buildFixture({
      fixture: 'dist-named-chunk-host',
      mfOptions: { name: 'hostApp', shared: { 'mock-shared-dep': {} } },
    });
    const widget = output.output.find(
      (chunk) =>
        chunk.type === 'chunk' && chunk.moduleIds.some((id) => id.includes('widget/dist/index.js'))
    )?.fileName;
    // The bundler names the chunk after the `dist` directory; other bundlers do not.
    if (!widget?.includes('/dist-')) return;

    const entry = findChunk(output, /index-/)!.code;
    expect(preloadDepsOf(entry, 'page')).toContain(widget);
    // The federation runtime chunk is named `dist` too, and still stays out.
    expect(preloadDepsOf(entry, 'runtime-page').filter((dep) => dep.includes('/dist-'))).toEqual(
      []
    );
  });
});

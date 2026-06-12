import type { HtmlTagDescriptor, IndexHtmlTransformContext } from 'vite';
import type { Rollup } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { pluginHostInitPreload } from '../pluginHostInitPreload';

type Handler = (html: string, ctx: IndexHtmlTransformContext) => HtmlTagDescriptor[] | undefined;

function chunk(name: string, fileName: string): Rollup.OutputChunk {
  return { type: 'chunk', name, fileName } as Rollup.OutputChunk;
}

function asset(name: string, fileName: string): Rollup.OutputAsset {
  return { type: 'asset', name, fileName } as Rollup.OutputAsset;
}

function bundleOf(...entries: Array<{ fileName: string }>): Record<string, Rollup.OutputBundle[string]> {
  return Object.fromEntries(entries.map(e => [e.fileName, e as Rollup.OutputBundle[string]]));
}

const baseHtml = (extraPreloads = '') => `<!doctype html>
<html>
  <head>
    <script type="module" crossorigin src="/assets/mf-entry-bootstrap-0-abc.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/chunk-existing.AAA.js">
${extraPreloads}  </head>
  <body></body>
</html>`;

const allFourChunks = () => [
  chunk('hostInit', 'assets/chunk-hostInit.D8.js'),
  chunk('remoteEntry', 'assets/chunk-remoteEntry.u3.js'),
  chunk('_virtual_mf-localSharedImportMap___app', 'assets/chunk-_virtual_mf-localSharedImportMap___app.Bl.js'),
  chunk('index', 'assets/chunk-index.B_.js'),
];

const FOUR_HREFS = [
  '/assets/chunk-hostInit.D8.js',
  '/assets/chunk-remoteEntry.u3.js',
  '/assets/chunk-_virtual_mf-localSharedImportMap___app.Bl.js',
  '/assets/chunk-index.B_.js',
];

function runTransform(html: string, bundle?: Record<string, unknown>): HtmlTagDescriptor[] | undefined {
  const plugin = pluginHostInitPreload();
  const hook = plugin.transformIndexHtml;
  const handler = (typeof hook === 'function' ? hook : (hook as { handler: Handler }).handler) as Handler;
  return handler(html, { bundle } as unknown as IndexHtmlTransformContext);
}

function hrefs(tags: HtmlTagDescriptor[] | undefined): (string | undefined)[] {
  return (tags ?? []).map(t => t.attrs?.href);
}

describe('pluginHostInitPreload', () => {
  it('injects modulepreload tags for all four host-init chunks', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tags = runTransform(baseHtml(), bundleOf(...allFourChunks()));

    expect(hrefs(tags)).toEqual(FOUR_HREFS);
    for (const tag of tags!) {
      expect(tag).toMatchObject({
        tag: 'link',
        injectTo: 'head',
        attrs: { rel: 'modulepreload', crossorigin: true },
      });
    }
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('skips chunks already preloaded by Vite', () => {
    const alreadyPreloaded = `    <link rel="modulepreload" crossorigin href="/assets/chunk-index.B_.js">\n`;
    const tags = runTransform(baseHtml(alreadyPreloaded), bundleOf(...allFourChunks()));

    expect(hrefs(tags)).toEqual(FOUR_HREFS.filter(h => h !== '/assets/chunk-index.B_.js'));
  });

  it('matches _virtual_mf* chunks by prefix', () => {
    const chunks = [
      chunk('hostInit', 'assets/chunk-hostInit.D8.js'),
      chunk('remoteEntry', 'assets/chunk-remoteEntry.u3.js'),
      chunk('_virtual_mf-differentName', 'assets/chunk-_virtual_mf-differentName.XY.js'),
      chunk('index', 'assets/chunk-index.B_.js'),
    ];
    const tags = runTransform(baseHtml(), bundleOf(...chunks));

    expect(hrefs(tags)).toContain('/assets/chunk-_virtual_mf-differentName.XY.js');
  });

  it('does not match "index" chunks with longer names like "indexPage"', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunks = [
      chunk('hostInit', 'assets/chunk-hostInit.D8.js'),
      chunk('remoteEntry', 'assets/chunk-remoteEntry.u3.js'),
      chunk('_virtual_mf-x', 'assets/chunk-_virtual_mf-x.Bl.js'),
      chunk('indexPage', 'assets/chunk-indexPage.CA.js'),
    ];
    const tags = runTransform(baseHtml(), bundleOf(...chunks));

    expect(hrefs(tags)).not.toContain('/assets/chunk-indexPage.CA.js');
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain('"index"');
    warn.mockRestore();
  });

  it('ignores asset-type bundle entries even when named like a host-init chunk', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tags = runTransform(baseHtml(), bundleOf(...allFourChunks(), asset('index', 'assets/index.AA.css')));

    expect(hrefs(tags)).toEqual(FOUR_HREFS);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns for each missing chunk but still preloads the ones found', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tags = runTransform(baseHtml(), bundleOf(chunk('hostInit', 'assets/chunk-hostInit.D8.js')));

    expect(hrefs(tags)).toEqual(['/assets/chunk-hostInit.D8.js']);
    expect(warn).toHaveBeenCalledTimes(3);
    const messages = warn.mock.calls.map(c => String(c[0])).join('\n');
    expect(messages).toContain('"remoteEntry"');
    expect(messages).toContain('"index"');
    expect(messages).toContain('"_virtual_mf*"');
    warn.mockRestore();
  });

  it('returns undefined with no tags when no host-init chunks are found', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tags = runTransform(baseHtml(), bundleOf(chunk('unrelated', 'assets/chunk-unrelated.AB.js')));

    expect(tags).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(4);
    warn.mockRestore();
  });

  it('is a no-op in serve mode (no bundle)', () => {
    expect(runTransform(baseHtml(), undefined)).toBeUndefined();
  });
});

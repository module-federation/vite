import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { federation } from '../src';
import { buildFixtureTo, createBrowser, serveDirectory } from './helpers/browser';

interface TestWindow extends Window {
  loadWidget(): Promise<{ urls: string[]; headLinks: number; color: string; lazyColor: string }>;
}

// README "CSS inside Shadow DOM": `?url` CSS of a remote built with `base: './'`.
it('lets an exposed module attach its ?url CSS to a ShadowRoot instead of document.head', async () => {
  const workspace = await mkdtemp(path.join(import.meta.dirname, '.css-shadow-dom-url-'));
  const closeServers: Array<() => Promise<void>> = [];
  let browser: Awaited<ReturnType<typeof createBrowser>> | undefined;

  async function buildApp(
    options: Parameters<typeof federation>[0],
    files: Record<string, string>
  ) {
    const root = path.join(workspace, options.name);
    await mkdir(root);
    await Promise.all(
      Object.entries(files).map(([name, source]) => writeFile(path.join(root, name), source))
    );
    const outDir = path.join(root, 'dist');
    await buildFixtureTo(root, outDir, { filename: 'remoteEntry.js', dts: false, ...options });
    const server = await serveDirectory(outDir);
    closeServers.push(server.close);
    return server.origin;
  }

  try {
    const remoteOrigin = await buildApp(
      { name: 'shadowRemote', exposes: { './Widget': './widget.js' } },
      {
        'index.html': '<!doctype html>',
        'vite.config.js': "export default { base: './' };",
        'widget.css': '.widget { color: rgb(255, 0, 0); }',
        'lazy.css': '.lazy { color: rgb(0, 0, 255); }',
        'lazy.js': 'export { default as lazyHref } from "./lazy.css?url";',
        'widget.js': `
          import widgetHref from './widget.css?url';
          export async function mount(shadowRoot) {
            const { lazyHref } = await import('./lazy.js');
            const urls = [widgetHref, lazyHref];
            await Promise.all(urls.map((href) => new Promise((resolve, reject) => {
              const link = document.createElement('link');
              link.rel = 'stylesheet';
              link.href = href;
              link.onload = resolve;
              link.onerror = reject;
              shadowRoot.appendChild(link);
            })));
            shadowRoot.append(document.createRange().createContextualFragment(
              '<span class="widget">w</span><span class="lazy">l</span>'
            ));
            return urls;
          }
        `,
      }
    );
    const hostOrigin = await buildApp(
      { name: 'shadowHost' },
      {
        'index.html': '<div id="host"></div><script type="module" src="/app.js"></script>',
        'app.js': `
          import { createInstance } from '@module-federation/runtime';
          const runtime = createInstance({
            name: 'shadowHost',
            remotes: [{ name: 'shadowRemote', type: 'module', entry: ${JSON.stringify(`${remoteOrigin}/remoteEntry.js`)} }],
          });
          window.loadWidget = async () => {
            const { mount } = await runtime.loadRemote('shadowRemote/Widget');
            const shadowRoot = document.querySelector('#host').attachShadow({ mode: 'open' });
            const urls = await mount(shadowRoot);
            const colorOf = (selector) => getComputedStyle(shadowRoot.querySelector(selector)).color;
            return {
              urls,
              headLinks: document.querySelectorAll('link[rel="stylesheet"]').length,
              color: colorOf('.widget'),
              lazyColor: colorOf('.lazy'),
            };
          };
        `,
      }
    );

    browser = await createBrowser();
    const page = await browser.newPage();
    await page.goto(hostOrigin);
    await page.waitForFunction(() => 'loadWidget' in window);
    const result = await page.evaluate(() => (window as TestWindow).loadWidget());

    expect(result.headLinks).toBe(0);
    expect(result.urls).toEqual([
      expect.stringMatching(new RegExp(`^${remoteOrigin}/assets/widget-[\\w-]{8}\\.css$`)),
      expect.stringMatching(new RegExp(`^${remoteOrigin}/assets/lazy-[\\w-]{8}\\.css$`)),
    ]);
    expect(result.color).toBe('rgb(255, 0, 0)');
    expect(result.lazyColor).toBe('rgb(0, 0, 255)');
  } finally {
    await browser?.close();
    await Promise.all(closeServers.map((close) => close()));
    await rm(workspace, { recursive: true, force: true });
  }
}, 45_000);

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { federation } from '../src';
import { buildFixtureTo, createBrowser, serveDirectory } from './helpers/browser';

interface TestWindow extends Window {
  loadWidget(): Promise<{ urls: string[]; headLinks: number; color: string; lazyColor: string }>;
  loadPlain(): Promise<{ headLinks: string[]; urls: unknown }>;
}

// mf-manifest.json: the MF runtime appends a manifest expose's CSS to document.head itself.
it.each(['remoteEntry.js', 'mf-manifest.json'])(
  'leaves manual expose CSS out of document.head and publishes its URLs; head exposes keep it (%s)',
  async (entryFile) => {
    const workspace = await mkdtemp(path.join(import.meta.dirname, '.css-injection-manual-'));
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
        {
          name: 'shadowRemote',
          manifest: true,
          // './Plain' keeps the default 'head'.
          exposes: {
            './Widget': { import: './widget.js', cssInjection: 'manual' },
            './Plain': './plain.js',
          },
        },
        {
          'index.html': '<!doctype html>',
          'plain.css': '.plain { color: rgb(0, 128, 0); }',
          'plain.js': 'import "./plain.css"; export const plain = true;',
          'widget.css': '.widget { color: rgb(255, 0, 0); }',
          'lazy.css': '.lazy { color: rgb(0, 0, 255); }',
          'lazy.js': 'import "./lazy.css"; export const lazyClass = "lazy";',
          'widget.js': `
          import './widget.css';
          export async function mount(shadowRoot) {
            const { lazyClass } = await import('./lazy.js');
            const urls = window['css__shadowRemote__./Widget'];
            await Promise.all(urls.map((href) => new Promise((resolve, reject) => {
              const link = document.createElement('link');
              link.rel = 'stylesheet';
              link.href = href;
              link.onload = resolve;
              link.onerror = reject;
              shadowRoot.appendChild(link);
            })));
            shadowRoot.append(document.createRange().createContextualFragment(
              '<span class="widget">w</span><span class="' + lazyClass + '">l</span>'
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
            remotes: [{ name: 'shadowRemote', type: 'module', entry: ${JSON.stringify(`${remoteOrigin}/${entryFile}`)} }],
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
          window.loadPlain = async () => {
            await runtime.loadRemote('shadowRemote/Plain');
            return {
              headLinks: [...document.querySelectorAll('link[rel="stylesheet"]')].map((link) => link.href),
              urls: window['css__shadowRemote__./Plain'],
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
      expect(result.urls).toHaveLength(2);
      for (const url of result.urls)
        expect(url).toMatch(new RegExp(`^${remoteOrigin}/assets/.+-[\\w-]{8}\\.css$`));
      expect(result.color).toBe('rgb(255, 0, 0)');
      expect(result.lazyColor).toBe('rgb(0, 0, 255)');

      const plain = await page.evaluate(() => (window as TestWindow).loadPlain());
      expect(plain.urls).toBeUndefined();
      expect(plain.headLinks).toEqual([expect.stringMatching(/\/assets\/plain-[\w-]{8}\.css$/)]);
    } finally {
      await browser?.close();
      await Promise.all(closeServers.map((close) => close()));
      await rm(workspace, { recursive: true, force: true });
    }
  },
  45_000
);

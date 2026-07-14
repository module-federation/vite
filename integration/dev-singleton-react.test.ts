import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer as createViteServer, version as viteVersion } from 'vite';
import { federation } from '../src';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURE_PARENT = path.join(REPO_ROOT, 'examples/vite-webpack-rspack/remote');
const VITE_CLI = path.join(REPO_ROOT, 'node_modules/vite/bin/vite.js');

const cleanupTasks: Array<() => Promise<void>> = [];
let fixtureRoot: string;

beforeEach(async () => {
  fixtureRoot = await mkdtemp(path.join(FIXTURE_PARENT, '.issue-913-'));
  await mkdir(path.join(fixtureRoot, 'src'));
  const pluginEntry = path.join(REPO_ROOT, 'src/index.ts');
  const ssrEntryLoaderEntry = path.join(REPO_ROOT, 'src/utils/ssrEntryLoader.ts');
  await Promise.all([
    writeFile(
      path.join(fixtureRoot, 'index.html'),
      '<div id="root"></div>\n<script type="module" src="/src/main.js"></script>\n'
    ),
    writeFile(
      path.join(fixtureRoot, 'src/main.js'),
      `import React from 'react';
import { createRoot } from 'react-dom/client';

window.__issue913HostReact = React;
const { default: RemoteHookComponent } = await import('issue913Remote/HookComponent');
createRoot(document.querySelector('#root')).render(
  React.createElement(RemoteHookComponent, { hostReact: React })
);
`
    ),
    writeFile(
      path.join(fixtureRoot, 'src/RemoteHookComponent.js'),
      `import React, { useState } from 'react';

window.__issue913RemoteReact = React;
export default function RemoteHookComponent({ hostReact }) {
  const [renderCount] = useState(1);
  return React.createElement(
    'div',
    { id: 'singleton-result' },
    \`${'${React.version}:${renderCount}:${String(hostReact === React)}'}\`
  );
}
`
    ),
    writeFile(
      path.join(fixtureRoot, 'vite.remote.config.js'),
      `import { federation } from ${JSON.stringify(pluginEntry)};

export default {
  cacheDir: process.env.ISSUE_913_CACHE_DIR,
  resolve: {
    alias: {
      '@module-federation/vite/ssrEntryLoader': ${JSON.stringify(ssrEntryLoaderEntry)},
    },
  },
  plugins: [federation({
    name: 'issue913Remote',
    filename: 'remoteEntry.js',
    exposes: { './HookComponent': './src/RemoteHookComponent.js' },
    dts: false,
    shared: {
      react: { singleton: true },
      'react-dom': { singleton: true },
    },
  })],
};
`
    ),
    writeFile(
      path.join(fixtureRoot, 'vite.host.config.js'),
      `import { federation } from ${JSON.stringify(pluginEntry)};

export default {
  cacheDir: process.env.ISSUE_913_CACHE_DIR,
  resolve: {
    alias: {
      '@module-federation/vite/ssrEntryLoader': ${JSON.stringify(ssrEntryLoaderEntry)},
    },
  },
  plugins: [federation({
    name: 'issue913Host',
    remotes: {
      issue913Remote: {
        type: 'module',
        name: 'issue913Remote',
        entry: \`${'${process.env.ISSUE_913_REMOTE_ORIGIN}'}/remoteEntry.js\`,
      },
    },
    dts: false,
    shared: {
      react: { singleton: true },
      'react-dom': { singleton: true },
    },
  })],
};
`
    ),
  ]);
  cleanupTasks.push(() => rm(fixtureRoot, { recursive: true }));
});

afterEach(async () => {
  await Promise.all(
    cleanupTasks
      .splice(0)
      .reverse()
      .map((cleanup) => cleanup())
  );
});

async function createDevServer(
  name: string,
  options: Parameters<typeof federation>[0]
): Promise<{ origin: string }> {
  const cacheDir = await mkdtemp(path.join(tmpdir(), `mf-vite-${name}-`));
  const viteServer = await createViteServer({
    root: fixtureRoot,
    cacheDir,
    logLevel: 'silent',
    plugins: [federation(options)],
    server: {
      cors: true,
      host: '127.0.0.1',
      port: 0,
    },
  });
  await viteServer.listen();
  const address = viteServer.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Vite HTTP server did not bind');
  const origin = `http://127.0.0.1:${address.port}`;
  cleanupTasks.push(async () => {
    await viteServer.close();
    await rm(cacheDir, { recursive: true });
  });
  return { origin };
}

async function getAvailablePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Port probe did not bind');
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function startCliServer(
  configFile: string,
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<{ origin: string }> {
  const port = await getAvailablePort();
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'mf-vite-issue-913-cli-'));
  const output: string[] = [];
  const child = spawn(
    process.execPath,
    [
      VITE_CLI,
      '--config',
      configFile,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    {
      cwd: fixtureRoot,
      env: { ...process.env, ...extraEnv, ISSUE_913_CACHE_DIR: cacheDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  child.stdout?.on('data', (chunk) => output.push(String(chunk)));
  child.stderr?.on('data', (chunk) => output.push(String(chunk)));
  cleanupTasks.push(async () => {
    await stopChild(child);
    await rm(cacheDir, { recursive: true });
  });

  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Vite child exited with ${child.exitCode}:\n${output.join('')}`);
    }
    try {
      const response = await fetch(origin);
      if (response.ok) return { origin };
    } catch {
      // The CLI has not started listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Vite child did not become ready:\n${output.join('')}`);
}

async function fetchModuleGraph(origin: string, entry: string): Promise<Map<string, string>> {
  const modules = new Map<string, string>();
  const pending = [entry];

  while (pending.length > 0 && modules.size < 150) {
    const moduleUrl = pending.shift()!;
    if (modules.has(moduleUrl)) continue;

    const response = await fetch(new URL(moduleUrl, origin));
    expect(response.status, moduleUrl).toBe(200);
    const source = await response.text();
    modules.set(moduleUrl, source);

    const imports = [
      ...source.matchAll(/(?:import|export)\s+(?:[^'";]*?\s+from\s*)?["']([^"']+)["']/g),
      ...source.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g),
    ];
    for (const match of imports) {
      const specifier = match[1];
      if (specifier.startsWith('/') && !modules.has(specifier)) pending.push(specifier);
    }
  }

  return modules;
}

describe(`singleton React dev fallback (Vite ${viteVersion})`, () => {
  it('serves an optimized ESM React provider', async () => {
    const { origin } = await createDevServer('issue-913-provider', {
      name: 'issue913Provider',
      filename: 'remoteEntry.js',
      dts: false,
      shared: {
        react: { singleton: true },
      },
    });

    const modules = await fetchModuleGraph(origin, '/src/RemoteHookComponent.js');
    const urls = [...modules.keys()];
    const sources = [...modules.values()];
    const reactPrebuild = [...modules].find(([url]) => url.includes('__prebuild__react__prebuild'));
    const optimizedReactUrl = urls.find((url) => /\/deps\/react\.js(?:\?|$)/.test(url));

    expect(sources.some((source) => source.includes('loadShare'))).toBe(true);
    expect(reactPrebuild).toBeDefined();
    expect(reactPrebuild?.[1]).toMatch(/\/deps\/react\.js(?:\?|["'])/);
    expect(urls.some((url) => /\/react\/index\.js(?:\?|$)/.test(url))).toBe(false);
    expect(optimizedReactUrl, JSON.stringify(urls, null, 2)).toBeDefined();
  });

  it('keeps one React instance while rendering a remote hook component', async () => {
    const remote = await startCliServer('vite.remote.config.js');
    const host = await startCliServer('vite.host.config.js', {
      ISSUE_913_REMOTE_ORIGIN: remote.origin,
    });

    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    cleanupTasks.push(() => browser.close());
    const page = await browser.newPage();
    const pageErrors = new Set<string>();
    const consoleErrors = new Set<string>();
    const requestFailures = new Set<string>();
    const errorResponses = new Set<string>();
    const requests = new Set<string>();
    page.on('pageerror', (error) => pageErrors.add(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.add(message.text());
    });
    page.on('requestfailed', (request) => {
      requestFailures.add(`${request.url()}: ${request.failure()?.errorText}`);
    });
    page.on('response', (response) => {
      if (response.status() >= 400) errorResponses.add(`${response.status()} ${response.url()}`);
    });
    page.on('request', (request) => requests.add(request.url()));
    await page.goto(host.origin, { waitUntil: 'domcontentloaded' });

    try {
      await page.locator('#singleton-result').waitFor({ timeout: 15_000 });
    } catch (error) {
      throw new Error(
        JSON.stringify(
          {
            cause: String(error),
            pageErrors: [...pageErrors],
            consoleErrors: [...consoleErrors],
            requestFailures: [...requestFailures],
            errorResponses: [...errorResponses],
            requests: [...requests],
            content: await page.content(),
          },
          null,
          2
        )
      );
    }
    await expect(page.locator('#singleton-result').textContent()).resolves.toMatch(
      /^\d+\.\d+\.\d+:1:true$/
    );
    await expect(
      page.evaluate(() => window.__issue913HostReact === window.__issue913RemoteReact)
    ).resolves.toBe(true);
    expect([...pageErrors]).toEqual([]);
    expect(
      [...consoleErrors].filter((error) => /invalid hook call|module is not defined/i.test(error))
    ).toEqual([]);
  }, 60_000);
});

declare global {
  interface Window {
    __issue913HostReact?: unknown;
    __issue913RemoteReact?: unknown;
  }
}

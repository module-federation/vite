import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  execFile as execFileCallback,
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'child_process';
import { resolve } from 'path';
import { promisify } from 'util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPRO_ROOT = resolve(process.cwd(), 'test-issue');
const execFile = promisify(execFileCallback);
const APPS = [
  { name: 'app-1', port: 5001 },
  { name: 'app-2', port: 5002 },
  { name: 'app-3', port: 5003 },
  { name: 'shell', port: 5000 },
] as const;

const previewProcesses: ChildProcessWithoutNullStreams[] = [];

async function waitForUrl(url: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`Unexpected status ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

function startPreview(appName: string) {
  const child = spawn(
    'npm',
    ['--prefix', `apps/${appName}`, 'run', 'preview', '--', '--host', '127.0.0.1'],
    {
      cwd: REPRO_ROOT,
      detached: true,
    }
  );

  previewProcesses.push(child);
  return child;
}

function stopPreview(child: ChildProcessWithoutNullStreams) {
  if (child.pid && !child.killed) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // The preview process can exit before cleanup if setup fails early.
    }
  }
}

describe('shared dependency cache across remote navigation', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    await execFile('npm', ['run', 'build'], {
      cwd: REPRO_ROOT,
      timeout: 90_000,
    });

    for (const app of APPS) {
      startPreview(app.name);
    }

    await Promise.all(
      APPS.map((app) => waitForUrl(`http://127.0.0.1:${app.port}`))
    );

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    page = await context.newPage();

    const client = await context.newCDPSession(page);
    await client.send('Network.enable');
    await client.send('Network.setCacheDisabled', { cacheDisabled: true });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    for (const child of previewProcesses) {
      stopPreview(child);
    }
  });

  it('does not download shared React chunks again after a share-cache hit', async () => {
    const sharedAssetResponses: Array<{ url: string; size: number }> = [];
    const pendingSharedAssetResponses: Promise<void>[] = [];

    page.on('response', (response) => {
      const url = response.url();
      if (url.includes('loadShare') || url.includes('prebuild')) {
        pendingSharedAssetResponses.push(
          response
            .body()
            .then((body) => {
              sharedAssetResponses.push({ url, size: body.byteLength });
            })
            .catch(() => {})
        );
      }
    });

    await page.goto('http://127.0.0.1:5000/app-1', { waitUntil: 'networkidle' });
    await page.getByText('app-1 page').waitFor();
    await Promise.all(pendingSharedAssetResponses);
    const afterApp1Count = sharedAssetResponses.length;

    await page.getByRole('link', { name: 'App 2' }).click();
    await page.getByText('app-2 page').waitFor();
    await page.waitForLoadState('networkidle');
    await Promise.all(pendingSharedAssetResponses);

    const app2SharedAssetResponses = sharedAssetResponses.slice(afterApp1Count);
    const shareCacheKeys = await page.evaluate(() => {
      const moduleCache = (globalThis as unknown as {
        __mf_module_cache__?: { share?: Record<string, unknown> };
      }).__mf_module_cache__;

      return Object.keys(moduleCache?.share ?? {});
    });

    expect(shareCacheKeys).toEqual(
      expect.arrayContaining([
        'react@19:react',
        'react@19:react-dom',
        'react@19:react-dom/client',
      ])
    );
    expect(shareCacheKeys).toHaveLength(4);
    expect(
      app2SharedAssetResponses.filter(
        ({ url, size }) => url.includes('prebuild') || size > 8_000
      )
    ).toEqual([]);
  }, 30_000);
});

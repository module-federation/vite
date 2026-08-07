import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { join, resolve, sep } from 'node:path';
import { chromium } from '@playwright/test';
import type { OutputChunk, RollupOutput } from 'rollup';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { federation } from '../src';

const enabled = process.env.EXPOSE_QUEUE_BENCHMARK === '1';
const exposeCount = readPositiveInteger('EXPOSE_QUEUE_BENCHMARK_EXPOSES', 21);
const bytesPerExpose = readPositiveInteger('EXPOSE_QUEUE_BENCHMARK_BYTES', 1_500_000);
const responseDelayMs = readNonNegativeInteger('EXPOSE_QUEUE_BENCHMARK_DELAY_MS', 120);

interface BenchmarkPageState {
  __exposeQueueBenchmarkResult?: BrowserBenchmarkResult;
  __exposeQueueBenchmarkError?: string;
}

interface BrowserBenchmarkResult {
  loadedExposeCount: number;
  measuredBytes: number;
  resourceCount: number;
  totalMs: number;
}

interface BenchmarkFixture {
  exposes: Record<string, string>;
  exposeChunkFileNames: Set<string>;
  fixtureRoot: string;
  outputDir: string;
}

interface BenchmarkServer {
  getMetrics: () => ServerBenchmarkMetrics;
  server: Server;
  port: number;
}

interface ServerBenchmarkMetrics {
  maxInFlight: number;
  requestCount: number;
  startSpanMs: number;
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function readNonNegativeInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function isOutputChunk(item: RollupOutput['output'][number]): item is OutputChunk {
  return item.type === 'chunk';
}

async function createBenchmarkFixture(): Promise<BenchmarkFixture> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'mf-expose-queue-'));
  const sourceDir = join(fixtureRoot, 'src');
  const outputDir = join(fixtureRoot, 'dist');
  const entryFile = join(fixtureRoot, 'entry.js');
  const exposes: Record<string, string> = {};
  const sourceFiles = new Set<string>();

  await mkdir(sourceDir, { recursive: true });
  await writeFile(entryFile, 'export const benchmarkEntry = true;\n');

  for (let index = 0; index < exposeCount; index += 1) {
    const exposeKey = `./expose-${index}`;
    const sourceFile = join(sourceDir, `expose-${index}.js`);
    const payload = 'x'.repeat(bytesPerExpose);

    await writeFile(
      sourceFile,
      [
        `export const id = ${JSON.stringify(exposeKey)};`,
        `export const payload = ${JSON.stringify(payload)};`,
        '',
      ].join('\n')
    );
    exposes[exposeKey] = sourceFile;
    sourceFiles.add(resolve(sourceFile));
    sourceFiles.add(await realpath(sourceFile));
  }

  const result = await build({
    root: fixtureRoot,
    logLevel: 'silent',
    plugins: [
      federation({
        name: 'exposeQueueBenchmarkRemote',
        filename: 'remoteEntry.js',
        exposes,
        dts: false,
      }),
    ],
    build: {
      emptyOutDir: true,
      minify: false,
      outDir: outputDir,
      rollupOptions: {
        input: entryFile,
      },
      target: 'chrome89',
    },
  });

  if (Array.isArray(result)) {
    await rm(fixtureRoot, { recursive: true, force: true });
    throw new Error('The expose queue benchmark expects a single Rollup output.');
  }

  const output = result as unknown as RollupOutput;
  const remoteEntry = output.output.find(
    (item) => item.type === 'chunk' && item.fileName === 'remoteEntry.js'
  );
  const exposeChunkFileNames = output.output
    .filter(isOutputChunk)
    .filter((chunk) => chunk.facadeModuleId && sourceFiles.has(resolve(chunk.facadeModuleId)))
    .map((chunk) => chunk.fileName);

  if (!remoteEntry || exposeChunkFileNames.length !== exposeCount) {
    await rm(fixtureRoot, { recursive: true, force: true });
    throw new Error(
      [
        'Could not identify the generated remote or expose chunks.',
        `remoteEntry=${remoteEntry?.fileName ?? 'missing'}`,
        `exposeChunks=${exposeChunkFileNames.length}/${exposeCount}`,
      ].join(' ')
    );
  }

  return {
    exposes,
    exposeChunkFileNames: new Set(exposeChunkFileNames),
    fixtureRoot,
    outputDir,
  };
}

function createBenchmarkPage(exposes: Record<string, string>, exposeChunkFileNames: Set<string>) {
  const exposeKeys = JSON.stringify(Object.keys(exposes));
  const exposePaths = JSON.stringify([...exposeChunkFileNames]);

  return `<!doctype html>
<html>
  <body>
    <script type="module">
      const exposeKeys = ${exposeKeys};
      const exposePaths = new Set(${exposePaths});
      const startedAt = performance.now();

      function getExposeResources() {
        return performance.getEntriesByType('resource')
          .filter((entry) => exposePaths.has(new URL(entry.name).pathname.slice(1)))
          .map((entry) => ({
            end: entry.responseEnd,
            start: entry.startTime,
            bytes: entry.transferSize || entry.encodedBodySize || 0,
          }));
      }

      try {
        const remote = await import('/remoteEntry.js?benchmark=' + Date.now());
        await Promise.all(exposeKeys.map((exposeKey) => remote.get(exposeKey)));
        const resources = getExposeResources();

        globalThis.__exposeQueueBenchmarkResult = {
          loadedExposeCount: exposeKeys.length,
          measuredBytes: resources.reduce((total, resource) => total + resource.bytes, 0),
          resourceCount: resources.length,
          totalMs: performance.now() - startedAt,
        };
      } catch (error) {
        globalThis.__exposeQueueBenchmarkError = String(error && error.stack || error);
      }
    </script>
  </body>
</html>`;
}

function getContentType(pathname: string): string {
  if (pathname.endsWith('.html')) return 'text/html; charset=utf-8';
  if (pathname.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (pathname.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'application/octet-stream';
}

async function startBenchmarkServer(
  outputDir: string,
  page: string,
  delayedPaths: Set<string>
): Promise<BenchmarkServer> {
  let activeRequests = 0;
  let maxInFlight = 0;
  const requestStarts: number[] = [];

  const getMetrics = (): ServerBenchmarkMetrics => {
    const firstRequestStart = requestStarts[0];
    const lastRequestStart = requestStarts[requestStarts.length - 1];

    return {
      maxInFlight,
      requestCount: requestStarts.length,
      startSpanMs:
        firstRequestStart === undefined || lastRequestStart === undefined
          ? 0
          : lastRequestStart - firstRequestStart,
    };
  };

  const server = createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;

      if (pathname === '/') {
        const body = Buffer.from(page);
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-length': body.byteLength,
          'content-type': 'text/html; charset=utf-8',
        });
        response.end(body);
        return;
      }

      const relativePath = decodeURIComponent(pathname.slice(1));
      const isMeasuredRequest = delayedPaths.has(relativePath);
      let requestFinished = false;

      const finishMeasuredRequest = () => {
        if (!isMeasuredRequest || requestFinished) return;
        requestFinished = true;
        activeRequests -= 1;
      };

      if (isMeasuredRequest) {
        requestStarts.push(performance.now());
        activeRequests += 1;
        maxInFlight = Math.max(maxInFlight, activeRequests);
        response.once('close', finishMeasuredRequest);
        response.once('finish', finishMeasuredRequest);
      }

      const filePath = resolve(outputDir, relativePath);
      const outputRoot = resolve(outputDir);

      if (filePath !== outputRoot && !filePath.startsWith(`${outputRoot}${sep}`)) {
        response.writeHead(403);
        response.end();
        return;
      }

      let body: Buffer;
      try {
        body = await readFile(filePath);
      } catch {
        response.writeHead(404);
        response.end();
        return;
      }

      if (isMeasuredRequest && responseDelayMs > 0) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, responseDelayMs));
      }

      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-length': body.byteLength,
        'content-type': getContentType(relativePath),
      });
      response.end(body);
    })().catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });

  await new Promise<void>((resolveServer, rejectServer) => {
    server.once('error', rejectServer);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectServer);
      resolveServer();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeBenchmarkServer(server);
    throw new Error('The expose queue benchmark server did not expose a TCP port.');
  }

  return { getMetrics, port: address.port, server };
}

async function closeBenchmarkServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveServer, rejectServer) => {
    server.close((error) => (error ? rejectServer(error) : resolveServer()));
  });
}

describe.skipIf(!enabled)('expose queue benchmark', () => {
  it('measures concurrent expose loading over a real browser waterfall', async () => {
    let fixtureRoot: string | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let benchmarkServer: BenchmarkServer | undefined;

    try {
      const fixture = await createBenchmarkFixture();
      fixtureRoot = fixture.fixtureRoot;
      const page = createBenchmarkPage(fixture.exposes, fixture.exposeChunkFileNames);
      benchmarkServer = await startBenchmarkServer(
        fixture.outputDir,
        page,
        fixture.exposeChunkFileNames
      );
      browser = await chromium.launch({ headless: true });
      const browserPage = await browser.newPage();

      await browserPage.goto(`http://127.0.0.1:${benchmarkServer.port}/`);
      await browserPage.waitForFunction(
        () =>
          '__exposeQueueBenchmarkResult' in globalThis ||
          '__exposeQueueBenchmarkError' in globalThis,
        undefined,
        { timeout: 60_000 }
      );

      const state = await browserPage.evaluate(() => {
        const pageState = globalThis as unknown as BenchmarkPageState;
        return {
          result: pageState.__exposeQueueBenchmarkResult,
          error: pageState.__exposeQueueBenchmarkError,
        };
      });

      if (state.error) throw new Error(state.error);
      expect(state.result).toBeDefined();
      expect(state.result?.loadedExposeCount).toBe(exposeCount);
      expect(state.result?.resourceCount).toBe(exposeCount);

      const serverMetrics = benchmarkServer.getMetrics();
      expect(serverMetrics.requestCount).toBe(exposeCount);

      console.log(
        '[expose-queue-benchmark]',
        JSON.stringify(
          {
            bytesPerExpose,
            expectedBytes: bytesPerExpose * exposeCount,
            exposeCount,
            maxInFlight: serverMetrics.maxInFlight,
            measuredBytes: state.result?.measuredBytes,
            responseDelayMs,
            resourceCount: state.result?.resourceCount,
            serverRequestCount: serverMetrics.requestCount,
            startSpanMs: serverMetrics.startSpanMs,
            totalMs: state.result?.totalMs,
          },
          null,
          2
        )
      );
    } finally {
      await browser?.close();
      if (benchmarkServer) await closeBenchmarkServer(benchmarkServer.server);
      if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 120_000);
});

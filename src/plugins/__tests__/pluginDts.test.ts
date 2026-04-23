import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import type { IncomingMessage, ServerResponse } from 'http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedConfig, MinimalPluginContextWithoutEnvironment, Rollup } from 'vite';
import { normalizeModuleFederationOptions } from '../../utils/normalizeModuleFederationOptions';
import { callHook } from '../../utils/__tests__/viteHookHelpers';

const hasPackageDependency = vi.hoisted(() => vi.fn(() => false));

vi.mock('../../utils/packageUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/packageUtils')>();
  return {
    ...actual,
    hasPackageDependency,
  };
});

import {
  createDevDtsAssetMiddleware,
  getDevDtsAssetPaths,
  resolveDtsPluginOptions,
} from '../pluginDts';
import pluginDts from '../pluginDts';

function runConfigResolved(
  plugin: NonNullable<ReturnType<typeof pluginDts>[number]>,
  config: ResolvedConfig
) {
  callHook(plugin.configResolved, {} as MinimalPluginContextWithoutEnvironment, config);
}

function runGenerateBundle(plugin: NonNullable<ReturnType<typeof pluginDts>[number]>) {
  return callHook(
    plugin.generateBundle,
    {} as Rollup.PluginContext,
    {} as Rollup.NormalizedOutputOptions,
    {} as Rollup.OutputBundle,
    false
  );
}

function createMockResponse() {
  const headers = new Map<string, string>();
  const response = new PassThrough() as PassThrough &
    Partial<ServerResponse> & {
      body: () => string;
      headers: Map<string, string>;
      statusCode: number;
    };
  const chunks: Buffer[] = [];

  response.statusCode = 0;
  response.headers = headers;
  response.setHeader = (name, value) => {
    headers.set(name, String(value));
    return response as unknown as ServerResponse<IncomingMessage>;
  };
  response.on('data', (chunk) => {
    chunks.push(Buffer.from(chunk));
  });
  response.body = () => Buffer.concat(chunks).toString('utf8');

  return response;
}

describe('pluginDts build', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasPackageDependency.mockReturnValue(false);
  });

  it('does not throw when dts options are invalid', async () => {
    const normalized = normalizeModuleFederationOptions({
      name: 'test-module',
      shareStrategy: 'loaded-first',
    });
    normalized.dts = {
      displayErrorInTerminal: false,
      consumeTypes: 123,
    } as unknown as typeof normalized.dts;

    const plugins = pluginDts(normalized);
    const buildPlugin = plugins.find((plugin) => plugin.name === 'module-federation-dts-build');
    expect(buildPlugin).toBeTruthy();
    if (!buildPlugin) throw new Error('build plugin missing');

    const config = {
      root: process.cwd(),
      build: { outDir: 'dist' },
    } as ResolvedConfig;

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    runConfigResolved(buildPlugin, config);
    await expect(runGenerateBundle(buildPlugin)).resolves.toBeUndefined();
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('defaults vue remotes to vue-tsc and API type generation', () => {
    hasPackageDependency.mockReturnValue(true);

    const normalized = normalizeModuleFederationOptions({
      name: 'remote',
      shareStrategy: 'loaded-first',
      exposes: {
        './remote-app': './src/App.vue',
      },
    });

    expect(resolveDtsPluginOptions(true, normalized, '/repo')).toEqual({
      generateTypes: {
        compilerInstance: 'vue-tsc',
        generateAPITypes: true,
      },
    });
  });

  it('serves dev dts assets from stable public paths', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-dts-assets-'));
    const distDir = path.join(tempDir, 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, '.dev-server.d.ts'), 'export type RemoteKeys = never;\n');

    const middleware = createDevDtsAssetMiddleware(
      getDevDtsAssetPaths({
        root: tempDir,
        outputDir: 'dist',
        publicTypesFolder: '@mf-types',
        base: '/foo/',
      })
    );

    const req = {
      method: 'GET',
      url: '/foo/@mf-types.d.ts',
    } as IncomingMessage;
    const res = createMockResponse();
    const finished = new Promise((resolve) => res.on('finish', resolve));
    const next = vi.fn();

    middleware(req, res as unknown as ServerResponse, next);
    await finished;

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/typescript');
    expect(res.body()).toContain('RemoteKeys');
  });

  it('returns 404 for missing public dev dts assets instead of falling through', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-dts-missing-'));
    const middleware = createDevDtsAssetMiddleware(
      getDevDtsAssetPaths({
        root: tempDir,
        outputDir: 'dist',
        publicTypesFolder: '@mf-types',
        base: '/',
      })
    );

    const req = {
      method: 'GET',
      url: '/@mf-types.zip',
    } as IncomingMessage;
    const res = createMockResponse();
    const next = vi.fn();

    middleware(req, res as unknown as ServerResponse, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
  });
});

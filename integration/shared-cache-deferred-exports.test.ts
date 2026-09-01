import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { parseAst } from 'rollup/parseAst';
import {
  normalizeModuleFederationOptions,
  type ModuleFederationOptions,
} from '../src/utils/normalizeModuleFederationOptions';
import VirtualModule from '../src/utils/VirtualModule';
import { generateRemoteEntry } from '../src/virtualModules/virtualRemoteEntry';
import {
  getLoadShareModulePath,
  writeLoadShareModule,
} from '../src/virtualModules/virtualShared_preBuild';
import { isRollupChunk } from './helpers/assertions';
import { buildFixture, FIXTURES } from './helpers/build';
import { findChunk, getAllChunkCode, getHtmlAsset } from './helpers/matchers';

/**
 * Integration tests for the pendingShareLoads / deferred export mechanism.
 *
 * Race condition: init() seeds __mfModuleCache.share with loadShare _exports
 * whose getters return undefined until initPromise resolves + ESM import
 * completes. When a cached exportModule exists at loadShare evaluation time
 * (seeded by initHost -> runtime.loadShare), the else branch must apply exports
 * synchronously — remotes have no bootstrap to await pendingShareLoads.
 *
 * The cache-miss branch (exportModule === undefined) defers via
 * pendingShareLoads so the host bootstrap can await them.
 */

const SHARED_DEP = 'mock-shared-dep';

function dataUrl(source: string): string {
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

type GeneratedRemoteModule = {
  get(moduleName: string): Promise<() => unknown>;
};

async function importTestRemote(exposesSource: string): Promise<GeneratedRemoteModule> {
  const remoteOptions = normalizeModuleFederationOptions({
    name: uniqueName('pending-share-remote'),
    exposes: { './Button': './Button.js' },
    dts: false,
  });
  const remoteGenerated = generateRemoteEntry(remoteOptions, undefined, 'build');
  const runtimeStub = dataUrl(
    'export function init() {}\nexport function loadRemote() { return Promise.resolve(); }'
  );
  const exposesImport = remoteGenerated.match(/import\("(virtual:mf-exposes:[^"]+)"\)/)?.[1];
  if (!exposesImport) throw new Error('generated remote entry did not import its exposes module');

  return (await import(
    dataUrl(
      remoteGenerated
        .replace('from "@module-federation/runtime"', `from ${JSON.stringify(runtimeStub)}`)
        .replace(
          `import(${JSON.stringify(exposesImport)})`,
          `import(${JSON.stringify(dataUrl(exposesSource))})`
        )
    )
  )) as GeneratedRemoteModule;
}

const REMOTE_MF_OPTIONS = {
  name: 'remoteApp',
  filename: 'remoteEntry.js',
  exposes: {
    './exposed': resolve(FIXTURES, 'shared-remote', 'exposed-module.js'),
  },
  shared: {
    [SHARED_DEP]: { singleton: true, requiredVersion: '^1.0.0' },
  },
  dts: false,
} satisfies Partial<ModuleFederationOptions>;

const HOST_MF_OPTIONS = {
  name: 'hostApp',
  filename: 'remoteEntry.js',
  hostInitInjectLocation: 'html',
  remotes: {
    remote1: {
      name: 'remote1',
      entry: 'http://localhost:3001/remoteEntry.js',
      type: 'module',
    },
  },
  shared: {
    'mock-shared-dep': { singleton: true, requiredVersion: '^1.0.0' },
  },
  dts: false,
} satisfies Partial<ModuleFederationOptions>;

const FUNCTION_NODE_TYPES = new Set([
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression',
]);

function getTopLevelAwaitOffsets(code: string): number[] {
  const offsets: number[] = [];

  function visit(node: unknown, functionDepth: number) {
    if (!node || typeof node !== 'object') return;

    const astNode = node as { type?: string; start?: number; [key: string]: unknown };
    if (
      (astNode.type === 'AwaitExpression' ||
        (astNode.type === 'ForOfStatement' && astNode.await === true)) &&
      functionDepth === 0
    ) {
      offsets.push(astNode.start ?? -1);
    }

    const nextFunctionDepth =
      functionDepth + (astNode.type && FUNCTION_NODE_TYPES.has(astNode.type) ? 1 : 0);
    for (const [key, value] of Object.entries(astNode)) {
      if (key === 'start' || key === 'end' || key === 'type') continue;
      if (Array.isArray(value)) {
        value.forEach((child) => visit(child, nextFunctionDepth));
      } else {
        visit(value, nextFunctionDepth);
      }
    }
  }

  visit(parseAst(code), 0);
  return offsets;
}

// ── Host bootstrap ─────────────────────────────────────────────────────────

describe('host bootstrap pendingShareLoads', () => {
  it('awaits Promise.all(pendingShareLoads) after initHost', async () => {
    const output = await buildFixture({
      fixture: 'basic-host',
      mfOptions: HOST_MF_OPTIONS,
    });

    const bootstrapAsset = output.output.find(
      (item) => item.type === 'asset' && item.fileName.includes('mf-entry-bootstrap')
    );
    expect(bootstrapAsset).toBeDefined();
    const bootstrapCode = (bootstrapAsset as unknown as { source: string }).source;

    // Bootstrap must call initHost first
    expect(bootstrapCode).toContain('initHost');
    // Then await pendingShareLoads if any exist (guarded by if-check)
    expect(bootstrapCode).toContain('pendingShareLoads');
    expect(bootstrapCode).toContain('Promise.all');
    // The pendingShareLoads await must come after initHost — no TLA
    expect(bootstrapCode).not.toMatch(/^await /);
  });

  it('guards pendingShareLoads with existence check (remotes have no bootstrap)', async () => {
    const output = await buildFixture({
      fixture: 'basic-host',
      mfOptions: HOST_MF_OPTIONS,
    });

    const bootstrapAsset = output.output.find(
      (item) => item.type === 'asset' && item.fileName.includes('mf-entry-bootstrap')
    );
    expect(bootstrapAsset).toBeDefined();
    const bootstrapCode = (bootstrapAsset as unknown as { source: string }).source;

    // Must use `if (__mfModuleCache.pendingShareLoads)` guard — not unconditional
    // This ensures remotes (which never set pendingShareLoads) don't break.
    expect(bootstrapCode).toMatch(/if\s*\(\s*__mfModuleCache\.pendingShareLoads\s*\)/);
  });
});

// ── Remote side: import:false shares (host-provided) ───────────────────────

describe('remote loadShare (import: false — host-provided)', () => {
  const REMOTE_IMPORT_FALSE = {
    ...REMOTE_MF_OPTIONS,
    shared: {
      [SHARED_DEP]: { import: false, singleton: true, requiredVersion: '^1.0.0' },
    },
  } satisfies Partial<ModuleFederationOptions>;

  it('applies host-provided exports synchronously when cache is populated', async () => {
    const output = await buildFixture({
      fixture: 'shared-remote',
      mfOptions: REMOTE_IMPORT_FALSE,
    });

    const loadShareChunk = output.output
      .filter((c) => c.type === 'chunk')
      .find((c) => c.fileName.includes('__loadShare__'));

    expect(loadShareChunk).toBeDefined();
    const code = (loadShareChunk as { code: string }).code;

    // Must use __mfApplyHostProvidedExports
    expect(code).toContain('__mfApplyHostProvidedExports');

    // The else branch (cache hit) must apply synchronously
    // Structure: if (exportModule === void 0) initPromise.then(...) else { __mfApplyHostProvidedExports(exportModule) }
    // Rollup/Vite versions differ on whether they keep braces or whitespace after `else`.
    const elseMatch = code.match(/else\s*{?\s*__mfApplyHostProvidedExports\(exportModule\)/);
    expect(elseMatch).not.toBeNull();

    // Must NOT register a pending share load in the else branch
    const elseIndex = code.lastIndexOf('else');
    const afterElse = code.slice(elseIndex, elseIndex + 200);
    expect(afterElse).not.toContain('pendingShareLoads');
  });

  it('does not unconditionally await pendingShareLoads in remote bootstrap', async () => {
    const output = await buildFixture({
      fixture: 'shared-remote',
      mfOptions: REMOTE_IMPORT_FALSE,
    });

    // Remote may have a bootstrap, but it must NOT unconditionally await
    // pendingShareLoads. The host uses `if (__mfModuleCache.pendingShareLoads)`
    // guard so remotes (which never set pendingShareLoads) don't crash.
    const bootstrapAsset = output.output.find(
      (item) => item.type === 'asset' && item.fileName.includes('mf-entry-bootstrap')
    );
    if (bootstrapAsset) {
      const bootstrapCode = (bootstrapAsset as unknown as { source: string }).source;
      // Must be guarded with if-check, not bare await
      if (bootstrapCode.includes('pendingShareLoads')) {
        expect(bootstrapCode).toMatch(/if\s*\(\s*__mfModuleCache\.pendingShareLoads\s*\)/);
      }
    }
  });
});

describe('pendingShareLoads lifecycle', () => {
  it('cleans a rejected import:false load and lets a later remote get recover', async () => {
    const pkg = uniqueName('pending-import-false-share');
    const options = normalizeModuleFederationOptions({
      name: uniqueName('pending-import-false-owner'),
      shared: { [pkg]: { import: false } },
      dts: false,
    });
    const loadShareId = getLoadShareModulePath(pkg, false, options);
    writeLoadShareModule(pkg, options.shared[pkg], 'build', false, options);
    const generated = VirtualModule.findById(loadShareId)?.code;
    expect(generated).toBeTruthy();
    if (!generated) return;

    const initKeyLiteral = generated.match(/const __mfPromiseGlobalKey = ([^;]+);/)?.[1];
    expect(initKeyLiteral).toBeTruthy();
    if (!initKeyLiteral) return;
    const initStateKey = JSON.parse(initKeyLiteral) as string;
    const exposeCallsKey = uniqueName('pending-import-false-expose-calls');
    const exposesReadyKey = uniqueName('pending-import-false-exposes-ready');

    delete (globalThis as Record<string, unknown>).__mf_module_cache__;
    try {
      await import(dataUrl(`${generated}\n// import:false rejection regression`));
      const moduleCache = (globalThis as any).__mf_module_cache__;
      const initState = (globalThis as any)[initStateKey];
      expect(moduleCache.pendingShareLoads).toHaveLength(1);

      const remoteModule = await importTestRemote(`
        const state = globalThis[${JSON.stringify(exposesReadyKey)}] ||= {};
        state.promise ||= new Promise((resolve) => { state.resolve = resolve; });
        await state.promise;
        export default {
          "./Button": () => {
            globalThis[${JSON.stringify(exposeCallsKey)}] =
              (globalThis[${JSON.stringify(exposeCallsKey)}] || 0) + 1;
            return Promise.resolve({ recovered: true });
          }
        };
      `);
      const currentGet = remoteModule.get('./Button');
      let currentGetSettled = false;
      void currentGet.then(
        () => {
          currentGetSettled = true;
        },
        () => {
          currentGetSettled = true;
        }
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      const exposesState = (globalThis as any)[exposesReadyKey];
      expect(exposesState?.resolve).toEqual(expect.any(Function));
      exposesState.resolve();
      await flushMicrotasks();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(currentGetSettled).toBe(false);

      const currentWaiter = Promise.all(moduleCache.pendingShareLoads);
      initState.initResolve({});
      const expectedError = `Shared module ${pkg} was imported before federation bootstrap finished`;
      await expect(currentWaiter).rejects.toThrow(expectedError);
      await expect(currentGet).rejects.toThrow(expectedError);
      expect((globalThis as any)[exposeCallsKey] || 0).toBe(0);
      await flushMicrotasks();
      expect(moduleCache.pendingShareLoads).toEqual([]);

      moduleCache.share[`default:${pkg}`] = { default: { recovered: true } };
      const factory = await remoteModule.get('./Button');
      expect(factory()).toEqual({ recovered: true });
      expect((globalThis as any)[exposeCallsKey]).toBe(1);
      expect(moduleCache.pendingShareLoads).toEqual([]);
    } finally {
      delete (globalThis as Record<string, unknown>).__mf_module_cache__;
      delete (globalThis as Record<string, unknown>)[initStateKey];
      delete (globalThis as Record<string, unknown>)[exposesReadyKey];
      delete (globalThis as Record<string, unknown>)[exposeCallsKey];
    }
  });

  it('cleans a failed lazy import before a successful retry', async () => {
    const pkg = SHARED_DEP;
    const options = normalizeModuleFederationOptions({
      name: uniqueName('pending-lazy-owner'),
      exposes: { './Button': './Button.js' },
      shared: {
        [pkg]: {
          singleton: true,
          treeShaking: { mode: 'runtime-infer', usedExports: ['value1'] },
        },
      },
      dts: false,
    });
    const loadShareId = getLoadShareModulePath(pkg, false, options);
    writeLoadShareModule(pkg, options.shared[pkg], 'build', false, options);
    const generated = VirtualModule.findById(loadShareId)?.code;
    expect(generated).toBeTruthy();
    if (!generated) return;

    const initKeyLiteral = generated.match(/const __mfPromiseGlobalKey = ([^;]+);/)?.[1];
    const localImport = generated.match(/return import\("([^"]+)"\)/)?.[1];
    expect(initKeyLiteral).toBeTruthy();
    expect(localImport).toBeTruthy();
    if (!initKeyLiteral || !localImport) return;
    const initStateKey = JSON.parse(initKeyLiteral) as string;

    delete (globalThis as Record<string, unknown>).__mf_module_cache__;
    try {
      const failedChunk = dataUrl("throw new Error('simulated shared chunk failure')");
      const firstEvaluation = generated
        .replace(/import\.meta\.env\.SSR/g, 'false')
        .replace(
          `import(${JSON.stringify(localImport)})`,
          `import(${JSON.stringify(failedChunk)})`
        );
      await import(dataUrl(`${firstEvaluation}\n// failed lazy import regression`));
      const moduleCache = (globalThis as any).__mf_module_cache__;
      const initState = (globalThis as any)[initStateKey];
      expect(moduleCache.pendingShareLoads).toHaveLength(1);

      const currentWaiter = Promise.all(moduleCache.pendingShareLoads);
      initState.initResolve({});
      await expect(currentWaiter).rejects.toThrow('simulated shared chunk failure');
      await flushMicrotasks();
      expect(moduleCache.pendingShareLoads).toEqual([]);

      const recoveredChunk = dataUrl(
        'export const value1 = "recovered"; export default { value1: "recovered" };'
      );
      const retryEvaluation = generated
        .replace(/import\.meta\.env\.SSR/g, 'false')
        .replace(
          `import(${JSON.stringify(localImport)})`,
          `import(${JSON.stringify(recoveredChunk)})`
        )
        .concat('\n// successful lazy import retry');
      await import(dataUrl(retryEvaluation));
      await flushMicrotasks();

      expect(moduleCache.share[`default:${pkg}`]).toMatchObject({
        default: { value1: 'recovered' },
      });
      expect(moduleCache.pendingShareLoads).toEqual([]);
    } finally {
      delete (globalThis as Record<string, unknown>).__mf_module_cache__;
      delete (globalThis as Record<string, unknown>)[initStateKey];
    }
  });

  it('lets a later remote get reach the expose factory after a failed lazy retry', async () => {
    const pkg = SHARED_DEP;
    const options = normalizeModuleFederationOptions({
      name: uniqueName('pending-lazy-remote-owner'),
      exposes: { './Button': './Button.js' },
      shared: {
        [pkg]: {
          singleton: true,
          treeShaking: { mode: 'runtime-infer', usedExports: ['value1'] },
        },
      },
      dts: false,
    });
    const loadShareId = getLoadShareModulePath(pkg, false, options);
    writeLoadShareModule(pkg, options.shared[pkg], 'build', false, options);
    const generated = VirtualModule.findById(loadShareId)?.code;
    expect(generated).toBeTruthy();
    if (!generated) return;

    const initKeyLiteral = generated.match(/const __mfPromiseGlobalKey = ([^;]+);/)?.[1];
    const localImport = generated.match(/return import\("([^"]+)"\)/)?.[1];
    expect(initKeyLiteral).toBeTruthy();
    expect(localImport).toBeTruthy();
    if (!initKeyLiteral || !localImport) return;
    const initStateKey = JSON.parse(initKeyLiteral) as string;
    const exposeCallsKey = uniqueName('pending-lazy-expose-calls');
    const exposesReadyKey = uniqueName('pending-lazy-exposes-ready');

    delete (globalThis as Record<string, unknown>).__mf_module_cache__;
    try {
      const failedChunk = dataUrl("throw new Error('simulated lazy remote failure')");
      const firstEvaluation = generated
        .replace(/import\.meta\.env\.SSR/g, 'false')
        .replace(
          `import(${JSON.stringify(localImport)})`,
          `import(${JSON.stringify(failedChunk)})`
        );
      await import(dataUrl(`${firstEvaluation}\n// lazy remote get failure regression`));

      const moduleCache = (globalThis as any).__mf_module_cache__;
      const initState = (globalThis as any)[initStateKey];
      expect(moduleCache.pendingShareLoads).toHaveLength(1);

      const remoteModule = await importTestRemote(`
        const state = globalThis[${JSON.stringify(exposesReadyKey)}] ||= {};
        state.promise ||= new Promise((resolve) => { state.resolve = resolve; });
        await state.promise;
        export default {
          "./Button": () => {
            globalThis[${JSON.stringify(exposeCallsKey)}] =
              (globalThis[${JSON.stringify(exposeCallsKey)}] || 0) + 1;
            return Promise.resolve({ recovered: true });
          }
        };
      `);
      const firstGet = remoteModule.get('./Button');
      let firstGetSettled = false;
      void firstGet.then(
        () => {
          firstGetSettled = true;
        },
        () => {
          firstGetSettled = true;
        }
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      const exposesState = (globalThis as any)[exposesReadyKey];
      expect(exposesState?.resolve).toEqual(expect.any(Function));
      exposesState.resolve();
      await flushMicrotasks();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(firstGetSettled).toBe(false);

      const currentWaiter = Promise.all(moduleCache.pendingShareLoads);
      initState.initResolve({});
      await expect(currentWaiter).rejects.toThrow('simulated lazy remote failure');
      await expect(firstGet).rejects.toThrow('simulated lazy remote failure');
      expect((globalThis as any)[exposeCallsKey] || 0).toBe(0);
      await flushMicrotasks();
      expect(moduleCache.pendingShareLoads).toEqual([]);

      const recoveredChunk = dataUrl(
        'export const value1 = "recovered"; export default { value1: "recovered" };'
      );
      const retryEvaluation = generated
        .replace(/import\.meta\.env\.SSR/g, 'false')
        .replace(
          `import(${JSON.stringify(localImport)})`,
          `import(${JSON.stringify(recoveredChunk)})`
        )
        .concat('\n// successful lazy remote get retry');
      await import(dataUrl(retryEvaluation));
      await flushMicrotasks();

      const factory = await remoteModule.get('./Button');
      expect(factory()).toEqual({ recovered: true });
      expect((globalThis as any)[exposeCallsKey]).toBe(1);
      expect(moduleCache.pendingShareLoads).toEqual([]);
    } finally {
      delete (globalThis as Record<string, unknown>).__mf_module_cache__;
      delete (globalThis as Record<string, unknown>)[initStateKey];
      delete (globalThis as Record<string, unknown>)[exposesReadyKey];
      delete (globalThis as Record<string, unknown>)[exposeCallsKey];
    }
  });

  it('cleans a rejected react-server scoped shared load in its separate cache', async () => {
    const pkg = uniqueName('pending-react-server-share');
    const exportConditions = ['react-server', 'node', 'import', 'module', 'default'];
    const options = normalizeModuleFederationOptions({
      name: uniqueName('pending-react-server-owner'),
      shared: {
        [pkg]: {
          import: false,
          shareScope: 'react-server',
        },
      },
      dts: false,
    });
    const loadShareId = getLoadShareModulePath(pkg, false, options);
    writeLoadShareModule(pkg, options.shared[pkg], 'build', false, options, exportConditions);
    const generated = VirtualModule.findById(loadShareId)?.code;
    expect(generated).toBeTruthy();
    if (!generated) return;

    expect(generated).toContain('__mf_module_cache_react_server__');
    expect(generated).toContain(`"canonical":"react-server:${pkg}"`);
    const initKeyLiteral = generated.match(/const __mfPromiseGlobalKey = ([^;]+);/)?.[1];
    expect(initKeyLiteral).toBeTruthy();
    if (!initKeyLiteral) return;
    const initStateKey = JSON.parse(initKeyLiteral) as string;

    delete (globalThis as Record<string, unknown>).__mf_module_cache__;
    delete (globalThis as Record<string, unknown>).__mf_module_cache_react_server__;
    try {
      await import(dataUrl(`${generated}\n// react-server pending load regression`));
      const moduleCache = (globalThis as any).__mf_module_cache_react_server__;
      const initState = (globalThis as any)[initStateKey];
      expect(options.shared[pkg].scope).toBe('react-server');
      expect((globalThis as any).__mf_module_cache__).toBeUndefined();
      expect(moduleCache.share[`default:${pkg}`]).toBeUndefined();
      expect(moduleCache.pendingShareLoads).toHaveLength(1);

      const currentWaiter = Promise.all(moduleCache.pendingShareLoads);
      initState.initResolve({});
      await expect(currentWaiter).rejects.toThrow(
        `Shared module ${pkg} was imported before federation bootstrap finished`
      );
      await flushMicrotasks();
      expect(moduleCache.pendingShareLoads).toEqual([]);
      expect(moduleCache.share[`default:${pkg}`]).toBeUndefined();
      expect(moduleCache.share[`react-server:${pkg}`]).toBeUndefined();
    } finally {
      delete (globalThis as Record<string, unknown>).__mf_module_cache__;
      delete (globalThis as Record<string, unknown>).__mf_module_cache_react_server__;
      delete (globalThis as Record<string, unknown>)[initStateKey];
    }
  });
});

// ── Host side: import:true shares (workspace singleton) ─────────────────────

describe('host loadShare (import: true — workspace singleton)', () => {
  it('defers cache-miss exports via pendingShareLoads', async () => {
    const output = await buildFixture({
      fixture: 'shared-remote',
      mfOptions: REMOTE_MF_OPTIONS,
    });

    const loadShareChunk = output.output
      .filter((c) => c.type === 'chunk')
      .find((c) => c.fileName.includes('__loadShare__'));

    expect(loadShareChunk).toBeDefined();
    const code = (loadShareChunk as { code: string }).code;

    // Cache-miss branch (if) must register with the pending-share tracker
    expect(code).toContain('pendingShareLoads');
    expect(code).toContain('initPromise');

    // The if branch must register a promise with the tracker.
    // Structure: if (exportModule === void 0) __mfTrackPendingShareLoad(initPromise.then(...))
    expect(code).toContain('__mfTrackPendingShareLoad(initPromise.then');
    expect(code).not.toContain('(__mfModuleCache.pendingShareLoads ||= []).push(initPromise.then');
  });

  it('applies lazy share exports synchronously when cache is populated', async () => {
    const output = await buildFixture({
      fixture: 'shared-remote',
      mfOptions: REMOTE_MF_OPTIONS,
    });

    const loadShareChunk = output.output
      .filter((c) => c.type === 'chunk')
      .find((c) => c.fileName.includes('__loadShare__'));

    expect(loadShareChunk).toBeDefined();
    const code = (loadShareChunk as { code: string }).code;

    // Must use __mfApplyLazyShareExports
    expect(code).toContain('__mfApplyLazyShareExports');

    // The else branch (cache hit) must apply synchronously
    // Structure: else { __mfApplyLazyShareExports(exportModule) }
    // Rollup/Vite versions differ on whether they keep braces or whitespace after `else`.
    const elseMatch = code.match(/else\s*{?\s*__mfApplyLazyShareExports\(exportModule\)/);
    expect(elseMatch).not.toBeNull();

    // Must NOT register a pending share load in the else branch
    const elseIndex = code.lastIndexOf('else');
    const afterElse = code.slice(elseIndex, elseIndex + 200);
    expect(afterElse).not.toContain('pendingShareLoads');
  });
});

// ── Cross-cutting: no TLAs ──────────────────────────────────────────────────

describe('no top-level awaits in generated code', () => {
  it('bootstrap uses async IIFE, not TLA', async () => {
    const output = await buildFixture({
      fixture: 'basic-host',
      mfOptions: HOST_MF_OPTIONS,
    });

    const bootstrapAsset = output.output.find(
      (item) => item.type === 'asset' && item.fileName.includes('mf-entry-bootstrap')
    );
    expect(bootstrapAsset).toBeDefined();
    const bootstrapCode = (bootstrapAsset as unknown as { source: string }).source;

    // Bootstrap must use IIFE pattern: (async () => { ... })().then(...)
    expect(bootstrapCode).toMatch(/\(\s*async\s*\(\)\s*=>/);
    expect(bootstrapCode).toMatch(/\}\)\(\)\.then\(/);

    // Must NOT have bare top-level await OUTSIDE the async IIFE.
    // The IIFE pattern is: (async () => { ... })().then(...)
    // Everything inside { } is fine — we only check outside.
    const iifeStart = bootstrapCode.indexOf('async ()');
    const iifeBodyStart = bootstrapCode.indexOf('{', iifeStart);
    const iifeEnd = bootstrapCode.indexOf('})().then(');
    const beforeIife = bootstrapCode.slice(0, iifeBodyStart);
    const afterIife = iifeEnd >= 0 ? bootstrapCode.slice(iifeEnd + '})().then('.length) : '';
    expect(beforeIife).not.toMatch(/^\s*await /m);
    expect(afterIife).not.toMatch(/^\s*await /m);
    expect(getTopLevelAwaitOffsets(bootstrapCode)).toEqual([]);
  });

  it('keeps remote federation chunks TLA-free for Safari', async () => {
    const output = await buildFixture({
      fixture: 'shared-remote',
      mfOptions: {
        ...REMOTE_MF_OPTIONS,
        exposes: {
          './exposed': resolve(FIXTURES, 'shared-remote', 'exposed-module.js'),
          './secondary': resolve(FIXTURES, 'shared-remote', 'exposed-secondary.js'),
        },
      },
      viteConfig: {
        build: { target: 'safari14' },
      },
    });

    const topLevelAwaitChunks = output.output
      .filter(isRollupChunk)
      .map((chunk) => ({ fileName: chunk.fileName, offsets: getTopLevelAwaitOffsets(chunk.code) }))
      .filter(({ offsets }) => offsets.length > 0);

    expect(topLevelAwaitChunks).toEqual([]);
  });
});

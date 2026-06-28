import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import type { ModuleFederationOptions } from '../src/utils/normalizeModuleFederationOptions';
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

    // Must NOT push to pendingShareLoads in the else branch
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
      (item) =>
        item.type === 'asset' &&
        item.fileName.includes('mf-entry-bootstrap')
    );
    if (bootstrapAsset) {
      const bootstrapCode = (
        bootstrapAsset as unknown as { source: string }
      ).source;
      // Must be guarded with if-check, not bare await
      if (bootstrapCode.includes('pendingShareLoads')) {
        expect(bootstrapCode).toMatch(
          /if\s*\(\s*__mfModuleCache\.pendingShareLoads\s*\)/
        );
      }
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

    // Cache-miss branch (if) must push to pendingShareLoads
    expect(code).toContain('pendingShareLoads');
    expect(code).toContain('initPromise');

    // The if branch must push a promise to pendingShareLoads
    // Structure: if (exportModule === void 0) (__mfModuleCache.pendingShareLoads ||= []).push(initPromise.then(...))
    const ifMatch = code.match(
      /if\s*\(exportModule\s*===\s*void 0\)\s*\(__mfModuleCache\.pendingShareLoads\s*\||=\s*\[\]\)\.push\(/
    );
    expect(ifMatch).not.toBeNull();
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

    // Must NOT push to pendingShareLoads in the else branch
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
      (item) =>
        item.type === 'asset' &&
        item.fileName.includes('mf-entry-bootstrap')
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
  });
});

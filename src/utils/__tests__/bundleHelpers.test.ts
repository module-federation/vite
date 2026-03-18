import { describe, expect, it } from 'vitest';
import { eagerEvaluateLazyInit, removeSideEffectLoadShareImports } from '../bundleHelpers';

const LOAD_SHARE_TAG = '__loadShare__';

const makeChunk = (code: string, fileName?: string) => ({
  type: 'chunk' as const,
  code,
  fileName: fileName ?? 'test.js',
});

const makeAsset = (source: string) => ({
  type: 'asset' as const,
  source,
});

describe('removeSideEffectLoadShareImports', () => {
  it('removes side-effect imports of loadShare chunks from non-loadShare chunks', () => {
    const bundle: Record<string, any> = {
      'assets/host__loadShare__react__loadShare__.mjs-abc123.js': makeChunk(
        'const react = "react";export{react};',
        'assets/host__loadShare__react__loadShare__.mjs-abc123.js'
      ),
      'assets/react-shared-bundle.js': makeChunk(
        'import"./host__loadShare__react__loadShare__.mjs-abc123.js";const useState = () => {};export{useState};',
        'assets/react-shared-bundle.js'
      ),
    };

    removeSideEffectLoadShareImports(bundle, LOAD_SHARE_TAG);

    expect(bundle['assets/react-shared-bundle.js'].code).toBe(
      'const useState = () => {};export{useState};'
    );
  });

  it('does not modify loadShare chunks themselves', () => {
    const loadShareCode =
      'import"./other__loadShare__dep__loadShare__.mjs-xyz.js";const x = 1;export{x};';
    const bundle: Record<string, any> = {
      'assets/host__loadShare__react__loadShare__.mjs-abc.js': makeChunk(
        loadShareCode,
        'assets/host__loadShare__react__loadShare__.mjs-abc.js'
      ),
      'assets/other__loadShare__dep__loadShare__.mjs-xyz.js': makeChunk(
        'const y = 2;export{y};',
        'assets/other__loadShare__dep__loadShare__.mjs-xyz.js'
      ),
    };

    removeSideEffectLoadShareImports(bundle, LOAD_SHARE_TAG);

    // loadShare chunk should keep its imports untouched
    expect(bundle['assets/host__loadShare__react__loadShare__.mjs-abc.js'].code).toBe(
      loadShareCode
    );
  });

  it('removes multiple side-effect imports from the same chunk', () => {
    const bundle: Record<string, any> = {
      'assets/host__loadShare__react__loadShare__.mjs-a.js': makeChunk('export const a = 1;'),
      'assets/host__loadShare__zustand__loadShare__.mjs-b.js': makeChunk('export const b = 2;'),
      'assets/shared-bundle.js': makeChunk(
        'import"./host__loadShare__react__loadShare__.mjs-a.js";import"./host__loadShare__zustand__loadShare__.mjs-b.js";const app = true;export{app};'
      ),
    };

    removeSideEffectLoadShareImports(bundle, LOAD_SHARE_TAG);

    expect(bundle['assets/shared-bundle.js'].code).toBe('const app = true;export{app};');
  });

  it('does nothing when no loadShare chunks exist', () => {
    const originalCode = 'import"./other.js";const x = 1;export{x};';
    const bundle: Record<string, any> = {
      'assets/other.js': makeChunk('export const y = 2;'),
      'assets/main.js': makeChunk(originalCode),
    };

    removeSideEffectLoadShareImports(bundle, LOAD_SHARE_TAG);

    expect(bundle['assets/main.js'].code).toBe(originalCode);
  });

  it('skips asset entries (non-chunk)', () => {
    const bundle: Record<string, any> = {
      'assets/host__loadShare__react__loadShare__.mjs-a.js': makeChunk('export const a = 1;'),
      'assets/style.css': makeAsset(
        'import"./host__loadShare__react__loadShare__.mjs-a.js";body{}'
      ),
    };

    removeSideEffectLoadShareImports(bundle, LOAD_SHARE_TAG);

    // Asset source should remain unchanged (function only processes chunks)
    expect(bundle['assets/style.css'].source).toContain('import');
  });
});

describe('eagerEvaluateLazyInit', () => {
  it('inserts await before export in loadShare chunks with lazy-init pattern', () => {
    // Rolldown output uses `n(( async () => {` with space before async
    const bundle: Record<string, any> = {
      'assets/host__loadShare__react__loadShare__.mjs-abc.js': makeChunk(
        'var _init_react = n(( async () => {await initPromise;const mod=await loadShare("react");}));export{_init_react as default};'
      ),
    };

    eagerEvaluateLazyInit(bundle, LOAD_SHARE_TAG);

    const code = bundle['assets/host__loadShare__react__loadShare__.mjs-abc.js'].code;
    expect(code).toContain('await _init_react();');
    expect(code).toContain('export{');
    // await should come before export
    const awaitIdx = code.indexOf('await _init_react();');
    const exportIdx = code.indexOf('export{');
    expect(awaitIdx).toBeLessThan(exportIdx);
  });

  it('does not modify non-loadShare chunks', () => {
    const originalCode =
      'var _init = n(( async () => {await doSomething();}));export{_init as default};';
    const bundle: Record<string, any> = {
      'assets/regular-chunk.js': makeChunk(originalCode),
    };

    eagerEvaluateLazyInit(bundle, LOAD_SHARE_TAG);

    expect(bundle['assets/regular-chunk.js'].code).toBe(originalCode);
  });

  it('does nothing when no lazy-init pattern is found', () => {
    const originalCode = 'const x = 1;export{x};';
    const bundle: Record<string, any> = {
      'assets/host__loadShare__react__loadShare__.mjs-abc.js': makeChunk(originalCode),
    };

    eagerEvaluateLazyInit(bundle, LOAD_SHARE_TAG);

    expect(bundle['assets/host__loadShare__react__loadShare__.mjs-abc.js'].code).toBe(originalCode);
  });

  it('does nothing when no export statement is found', () => {
    const originalCode = 'var _init=__esmMin(async()=>{await doSomething();});';
    const bundle: Record<string, any> = {
      'assets/host__loadShare__react__loadShare__.mjs-abc.js': makeChunk(originalCode),
    };

    eagerEvaluateLazyInit(bundle, LOAD_SHARE_TAG);

    expect(bundle['assets/host__loadShare__react__loadShare__.mjs-abc.js'].code).toBe(originalCode);
  });

  it('handles multiple loadShare chunks independently', () => {
    const bundle: Record<string, any> = {
      'assets/host__loadShare__react__loadShare__.mjs-a.js': makeChunk(
        'var _init_react = n(( async () => {await loadReact();}));export{_init_react};'
      ),
      'assets/host__loadShare__zustand__loadShare__.mjs-b.js': makeChunk(
        'var _init_zustand = n(( async () => {await loadZustand();}));export{_init_zustand};'
      ),
    };

    eagerEvaluateLazyInit(bundle, LOAD_SHARE_TAG);

    expect(bundle['assets/host__loadShare__react__loadShare__.mjs-a.js'].code).toContain(
      'await _init_react();'
    );
    expect(bundle['assets/host__loadShare__zustand__loadShare__.mjs-b.js'].code).toContain(
      'await _init_zustand();'
    );
  });
});

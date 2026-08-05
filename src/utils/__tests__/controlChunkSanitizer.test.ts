import { describe, expect, it } from 'vitest';
import {
  isFederationControlChunk,
  sanitizeFederationControlChunk,
  stripEmptyPreloadCalls,
} from '../controlChunkSanitizer';

describe('controlChunkSanitizer', () => {
  it('strips minified preload helpers and loadShare side-effect imports', () => {
    const code =
      'import{_ as or}from"./assets/TreeLoader-KqsPzsXB.js";' +
      'import"./assets/reproApp__loadShare__react__loadShare__.js-DOStu9DH.js";' +
      'async function load(){return or(()=>import("./assets/localSharedImportMap.js"),[],import.meta.url)}';

    expect(stripEmptyPreloadCalls(code)).toBe(
      'async function load(){return import("./assets/localSharedImportMap.js")}'
    );
  });

  it('removes remoteEntry side-effect imports from localSharedImportMap chunks', () => {
    const code =
      'import "../remoteEntry.js";' + 'import "./other.js";' + 'export const usedShared = {};';

    expect(
      sanitizeFederationControlChunk(code, 'assets/localSharedImportMap-abc.js', 'remoteEntry.js')
    ).toBe('import "./other.js";export const usedShared = {};');
  });

  it('preserves preload helpers with non-empty dependency arrays', () => {
    const code =
      'import{_ as o}from"./preload-helper-BDBacUwf.js";' +
      'const n={' +
      '"@byte/api":async()=>await import("./index-DaqjAZdf.js"),' +
      '"@byte/ui":async()=>await o(()=>import("./index-Bc0YS1wt.js"),__vite__mapDeps([0]),import.meta.url),' +
      '"@byte/user-session":async()=>await o(()=>import("./index-BV4s8wZv.js"),[],import.meta.url),' +
      '"react":async()=>await import("./index-DlZQ-_sN.js")' +
      '}';

    const result = stripEmptyPreloadCalls(code);

    expect(result).toContain(
      '"@byte/ui":async()=>await o(()=>import("./index-Bc0YS1wt.js"),__vite__mapDeps([0]),import.meta.url)'
    );

    expect(result).toContain('"@byte/user-session":async()=>await import("./index-BV4s8wZv.js")');

    expect(result).not.toMatch(/await import\([^)]+\),__vite__mapDeps/);
  });

  it('does not break when only non-empty preload helpers exist', () => {
    const code =
      'import{_ as o}from"./preload-helper.js";' +
      'const n={' +
      '"@byte/ui":async()=>await o(()=>import("./ui.js"),__vite__mapDeps([0]),import.meta.url)' +
      '}';

    const result = stripEmptyPreloadCalls(code);

    expect(result).toContain('o(()=>import("./ui.js"),__vite__mapDeps([0]),import.meta.url)');
  });

  it('keeps `_` imports whose binding is referenced as a value instead of called', () => {
    // Rollup renders `import * as ns from "virtual:..."` as `import { _ as ns } from "<chunk>"`
    // when the module ends up in another chunk. Such a binding is returned, not called, so a
    // call-only check would strip the import and leave `ns` as an undeclared free identifier.
    const code =
      'import{_ as __vitePreload}from"./assets/preload-helper-CWZBUsdZ.js";' +
      'import{_ as __mfLocalSharedImportMap}from"./assets/_virtual_mf-localSharedImportMap-CiudmNFF.js";' +
      'async function getLocalSharedImportMap(){return __mfLocalSharedImportMap}';

    const result = stripEmptyPreloadCalls(code);

    expect(result).toContain(
      'import{_ as __mfLocalSharedImportMap}from"./assets/_virtual_mf-localSharedImportMap-CiudmNFF.js";'
    );
    // the genuinely unused preload helper is still removed
    expect(result).not.toContain('preload-helper-CWZBUsdZ.js');
  });

  it('detects federation control chunks', () => {
    expect(isFederationControlChunk('remoteEntry.js', 'remoteEntry.js')).toBe(true);
    expect(isFederationControlChunk('assets/hostInit-abc.js', 'remoteEntry.js')).toBe(true);
    expect(isFederationControlChunk('assets/localSharedImportMap-abc.js', 'remoteEntry.js')).toBe(
      true
    );
    expect(isFederationControlChunk('assets/app-abc.js', 'remoteEntry.js')).toBe(false);
  });
});

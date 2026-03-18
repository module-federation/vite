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
      'import"./assets/reproApp__loadShare__react__loadShare__.mjs-DOStu9DH.js";' +
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

  it('detects federation control chunks', () => {
    expect(isFederationControlChunk('remoteEntry.js', 'remoteEntry.js')).toBe(true);
    expect(isFederationControlChunk('assets/hostInit-abc.js', 'remoteEntry.js')).toBe(true);
    expect(isFederationControlChunk('assets/localSharedImportMap-abc.js', 'remoteEntry.js')).toBe(
      true
    );
    expect(isFederationControlChunk('assets/app-abc.js', 'remoteEntry.js')).toBe(false);
  });
});

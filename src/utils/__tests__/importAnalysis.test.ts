import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAst } from 'vite';
import { getImportAnalysis } from '../importAnalysis';
import { collectTreeShakingImports } from '../treeShaking';
import { normalizeModuleFederationOptions } from '../normalizeModuleFederationOptions';

vi.mock('vite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vite')>();
  return { ...actual, parseAst: vi.fn(actual.parseAst) };
});

beforeEach(() => vi.clearAllMocks());

const code = 'import { value } from "library";';

describe('import analysis', () => {
  it('parses the same source once for callers in the same build', () => {
    const build = {};
    expect(getImportAnalysis(build).analyze(code)).toEqual([
      { source: 'library', names: ['value'] },
    ]);
    expect(getImportAnalysis(build).analyze(code)).toEqual([
      { source: 'library', names: ['value'] },
    ]);
    expect(parseAst).toHaveBeenCalledTimes(1);
  });

  it('keeps separate builds independent when one cache is cleared', () => {
    const client = getImportAnalysis({});
    const server = getImportAnalysis({});
    client.analyze(code);
    server.analyze(code);
    client.clear();
    server.analyze(code);
    expect(parseAst).toHaveBeenCalledTimes(2);
    client.analyze(code);
    expect(parseAst).toHaveBeenCalledTimes(3);
  });

  it('analyzes changed source and starts fresh after a rebuild', () => {
    const analysis = getImportAnalysis({});
    analysis.analyze(code);
    const changed = 'import { updated } from "library";';
    expect(analysis.analyze(changed)).toEqual([{ source: 'library', names: ['updated'] }]);
    expect(parseAst).toHaveBeenCalledTimes(2);
    analysis.clear();
    expect(analysis.analyze(changed)).toEqual([{ source: 'library', names: ['updated'] }]);
    expect(parseAst).toHaveBeenCalledTimes(3);
  });

  it('reuses empty results and parse failures', () => {
    const analysis = getImportAnalysis({});
    for (let index = 0; index < 2; index++) {
      expect(analysis.analyze('export const value = 1;')).toEqual([]);
      expect(analysis.analyze('import {')).toBeNull();
    }
    expect(parseAst).toHaveBeenCalledTimes(2);
  });

  it('retains side effects and nested dynamic imports and require calls', () => {
    expect(
      getImportAnalysis({}).analyze(`
      export /* comment */ {} from 'side-effects';
      async function load() {
        await import(\`dynamic\`);
        return require('commonjs');
      }
    `)
    ).toEqual([
      { source: 'side-effects', names: null },
      { source: 'dynamic', names: null },
      { source: 'commonjs', names: null },
    ]);
  });

  it('resolves cached imports separately for each sharing configuration', async () => {
    const analysis = getImportAnalysis({});
    const first = normalizeModuleFederationOptions({
      name: 'first',
      shared: { first: { import: false } },
    });
    const second = normalizeModuleFederationOptions({
      name: 'second',
      shared: { second: { import: false } },
    });
    const recordFirst = vi.fn();
    const recordSecond = vi.fn();
    const unsafe = vi.fn();
    const resolveFirst = vi.fn(async () => 'first');
    const resolveSecond = vi.fn(async () => 'second');
    await collectTreeShakingImports(
      code,
      '/entry.js',
      first.shared,
      resolveFirst,
      recordFirst,
      unsafe,
      analysis
    );
    await collectTreeShakingImports(
      code,
      '/entry.js',
      second.shared,
      resolveSecond,
      recordSecond,
      unsafe,
      analysis
    );
    expect(parseAst).toHaveBeenCalledTimes(1);
    expect(resolveFirst).toHaveBeenCalledWith('library', first.shared);
    expect(resolveSecond).toHaveBeenCalledWith('library', second.shared);
    expect(recordFirst).toHaveBeenCalledWith('first', ['value'], 'library');
    expect(recordSecond).toHaveBeenCalledWith('second', ['value'], 'library');
    expect(unsafe).not.toHaveBeenCalled();
  });

  it('applies cached parse failures to each instance without sharing export state', async () => {
    const analysis = getImportAnalysis({});
    const first = normalizeModuleFederationOptions({
      name: 'first',
      shared: { first: { import: false } },
    });
    const second = normalizeModuleFederationOptions({
      name: 'second',
      shared: { second: { import: false } },
    });
    const markFirst = vi.fn();
    const markSecond = vi.fn();
    const resolve = vi.fn();
    const record = vi.fn();
    await collectTreeShakingImports(
      'import {',
      '/entry.js',
      first.shared,
      resolve,
      record,
      markFirst,
      analysis
    );
    await collectTreeShakingImports(
      'import {',
      '/entry.js',
      second.shared,
      resolve,
      record,
      markSecond,
      analysis
    );
    expect(parseAst).toHaveBeenCalledTimes(1);
    expect(markFirst).toHaveBeenCalledWith('first', '*');
    expect(markSecond).toHaveBeenCalledWith('second', '*');
    expect(resolve).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('excludes generated wrappers before parsing or applying cached imports', async () => {
    const analysis = getImportAnalysis({});
    const shared = normalizeModuleFederationOptions({
      name: 'host',
      shared: { library: { import: false } },
    }).shared;
    const resolve = vi.fn(() => 'library');
    const record = vi.fn();
    const unsafe = vi.fn();
    for (const tag of ['__loadShare__', '__prebuild__', '__mf_tree_shaking_graph__']) {
      await collectTreeShakingImports(
        code,
        `C:\\repo\\${tag}.js`,
        shared,
        resolve,
        record,
        unsafe,
        analysis
      );
    }
    expect(parseAst).not.toHaveBeenCalled();
    analysis.analyze(code);
    await collectTreeShakingImports(
      code,
      '/__loadShare__.js',
      shared,
      resolve,
      record,
      unsafe,
      analysis
    );
    expect(parseAst).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(unsafe).not.toHaveBeenCalled();
  });
});

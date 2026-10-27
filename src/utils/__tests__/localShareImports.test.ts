import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getImportedLocalShares, getLocalShareSourceFile } from '../localShareImports';
import type { ShareItem } from '../normalizeModuleFederationOptions';

const shareItem = (importSource: string | false | undefined): ShareItem => ({
  name: 'app/slice',
  version: '0.0.1',
  scope: 'default',
  from: '',
  shareConfig: { import: importSource, singleton: true, eager: false, requiredVersion: '0.0.1' },
});

describe('local share source files', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'mf-local-share-'));
    mkdirSync(path.join(root, 'src', 'reducers'), { recursive: true });
    writeFileSync(
      path.join(root, 'src', 'slice.ts'),
      "import { createSlice } from '@reduxjs/toolkit';\n"
    );
    writeFileSync(
      path.join(root, 'src', 'reducers', 'index.ts'),
      "export { default as counter } from './counter';\n"
    );
    writeFileSync(
      path.join(root, 'src', 'reducers', 'counter.ts'),
      "import { counter } from '../slice.js';\nimport type { Store } from 'app/store';\nexport default counter;\n"
    );
    writeFileSync(
      path.join(root, 'src', 'store.ts'),
      "import { configureStore } from '@reduxjs/toolkit';\nimport reducers from 'app/reducers';\nimport { helper } from './helper';\n"
    );
    writeFileSync(path.join(root, 'src', 'helper.ts'), "import { counter } from 'app/slice';\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves a path import of a share whose package is not installed', () => {
    expect(getLocalShareSourceFile('app/slice', shareItem(path.join(root, 'src', 'slice')))).toBe(
      path.join(root, 'src', 'slice.ts')
    );
    expect(
      getLocalShareSourceFile('app/reducers', shareItem(path.join(root, 'src', 'reducers')))
    ).toBe(path.join(root, 'src', 'reducers', 'index.ts'));
  });

  it('ignores bare imports, consume-only shares, shims of installed packages and missing files', () => {
    expect(getLocalShareSourceFile('app/slice', shareItem(undefined))).toBeUndefined();
    expect(getLocalShareSourceFile('app/slice', shareItem(false))).toBeUndefined();
    expect(getLocalShareSourceFile('app/slice', shareItem('some-package'))).toBeUndefined();
    expect(
      getLocalShareSourceFile('vite', shareItem(path.join(root, 'src', 'slice.ts')))
    ).toBeUndefined();
    expect(
      getLocalShareSourceFile('app/missing', shareItem(path.join(root, 'src', 'missing.ts')))
    ).toBeUndefined();
  });

  it('finds the local shares a source imports by key, by file and through unshared project files', () => {
    const localShareFiles = new Map([
      ['app/slice', path.join(root, 'src', 'slice.ts')],
      ['app/reducers', path.join(root, 'src', 'reducers', 'index.ts')],
      ['app/store', path.join(root, 'src', 'store.ts')],
    ]);
    expect(getImportedLocalShares(localShareFiles.get('app/slice')!, localShareFiles)).toEqual([]);
    // counter.ts imports '../slice.js', which is slice.ts; the type import of app/store does not count.
    expect(getImportedLocalShares(localShareFiles.get('app/reducers')!, localShareFiles)).toEqual([
      'app/slice',
    ]);
    // store.ts imports app/reducers by key and app/slice through the unshared helper.ts.
    expect(getImportedLocalShares(localShareFiles.get('app/store')!, localShareFiles)).toEqual([
      'app/reducers',
      'app/slice',
    ]);
  });

  it('matches a share by its request when it differs from the key', () => {
    const localShareFiles = new Map([
      ['slice-share', path.join(root, 'src', 'slice.ts')],
      ['app/store', path.join(root, 'src', 'store.ts')],
    ]);
    const requests = new Map([['app/slice', 'slice-share']]);
    expect(
      getImportedLocalShares(localShareFiles.get('app/store')!, localShareFiles, requests)
    ).toEqual(['slice-share']);
  });

  it('only follows the static, non-type imports a source evaluates', () => {
    writeFileSync(
      path.join(root, 'src', 'store.ts'),
      [
        "import { type Store, type State } from 'app/reducers';",
        'const s = "import x from \'app/reducers\'";',
        "const lazy = () => import('app/reducers');",
        "const url = 'http://example.com//path'; import { helper } from './helper';",
      ].join('\n')
    );
    const localShareFiles = new Map([
      ['app/slice', path.join(root, 'src', 'slice.ts')],
      ['app/reducers', path.join(root, 'src', 'reducers', 'index.ts')],
      ['app/store', path.join(root, 'src', 'store.ts')],
    ]);
    expect(getImportedLocalShares(localShareFiles.get('app/store')!, localShareFiles)).toEqual([
      'app/slice',
    ]);
  });
});

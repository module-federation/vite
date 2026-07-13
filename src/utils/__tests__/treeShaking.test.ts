import { beforeEach, describe, expect, it } from 'vitest';
import type {
  NormalizedShared,
  ShareItem,
  TreeShakingConfig,
} from '../normalizeModuleFederationOptions';
import {
  collectTreeShakingImports,
  getTreeShakingExportUsage,
  getTreeShakingUsedExports,
  markTreeShakingPackageUnsafe,
  recordTreeShakingExports,
  resetTreeShakingExports,
  setTreeShakingBuildMode,
} from '../treeShaking';

function createShareItem(treeShaking?: TreeShakingConfig): ShareItem {
  return {
    name: 'test-package',
    from: '',
    version: '1.0.0',
    scope: 'default',
    shareConfig: {
      requiredVersion: '^1.0.0',
      singleton: false,
      strictVersion: false,
      ...(treeShaking ? { treeShaking } : {}),
    },
  };
}

const antdShare = createShareItem({ mode: 'runtime-infer' });
const lodashPrefixShare = createShareItem({ mode: 'runtime-infer' });
const notTreeShakenShare = createShareItem();

function createShared(): NormalizedShared {
  return {
    antd: antdShare,
    'lodash/': lodashPrefixShare,
    plain: notTreeShakenShare,
  };
}

function findSharedKey(source: string, shared: NormalizedShared) {
  if (shared[source]) return source;
  return Object.keys(shared).find((key) => key.endsWith('/') && source.startsWith(key));
}

type RecordedUsage = { key: string; names: string[]; request?: string };
type UnsafeUsage = { key: string; request?: string };

function analyze(code: string, id = '/repo/src/App.js') {
  const recorded: RecordedUsage[] = [];
  const unsafe: UnsafeUsage[] = [];
  collectTreeShakingImports(
    code,
    id,
    createShared(),
    findSharedKey,
    (key, names, request) => recorded.push({ key, names, request }),
    (key, request) => unsafe.push({ key, request })
  );
  return { recorded, unsafe };
}

describe('collectTreeShakingImports', () => {
  it('collects default, named, aliased, and re-exported bindings', () => {
    const { recorded, unsafe } = analyze(`
      import Default, {
        Button as Primary
      } from 'antd';
      export { Input as Field, default as AntDefault } from 'antd';
    `);

    expect(recorded).toEqual([
      {
        key: 'antd',
        names: ['default', 'Button'],
        request: 'antd',
      },
      { key: 'antd', names: ['Input', 'default'], request: 'antd' },
    ]);
    expect(unsafe).toEqual([]);
  });

  it('falls back to the full bundle for string-named imports and re-exports', () => {
    const { recorded, unsafe } = analyze(`
      import { "custom-export" as customExport } from 'antd';
      export { "another-export" as publicName } from 'antd';
    `);

    expect(recorded).toEqual([]);
    expect(unsafe).toEqual([
      { key: 'antd', request: 'antd' },
      { key: 'antd', request: 'antd' },
    ]);
  });

  it('marks namespace, star re-export, dynamic, side-effect, empty, and require forms unsafe', () => {
    const { recorded, unsafe } = analyze(`
      import * as Ant from 'antd';
      export * from 'antd';
      export * as AntNamespace from 'antd';
      import('antd');
      import 'antd';
      import {} from 'antd';
      require('antd');
    `);

    expect(recorded).toEqual([]);
    expect(unsafe).toEqual(Array.from({ length: 7 }, () => ({ key: 'antd', request: 'antd' })));
  });

  it('recognizes generated Windows modules after path normalization', () => {
    const { recorded, unsafe } = analyze(
      `import { Button } from 'antd';`,
      'C:\\repo\\node_modules\\__mf__virtual\\antd__prebuild__.js'
    );

    expect(recorded).toEqual([]);
    expect(unsafe).toEqual([]);
  });

  it('does not interpret import-looking text in comments, strings, templates, or regexes', () => {
    const { recorded, unsafe } = analyze(`
      // import { MissingFromComment } from 'antd';
      /* export * from 'antd'; */
      const stringValue = "import { MissingFromString } from 'antd'";
      const templateValue = \`export * from 'antd'\`;
      const pattern = /import\\s+['"]antd['"]/;
      import { Button } from 'antd';
    `);

    expect(recorded).toEqual([{ key: 'antd', names: ['Button'], request: 'antd' }]);
    expect(unsafe).toEqual([]);
  });

  it('keeps concrete prefix requests isolated', () => {
    const { recorded, unsafe } = analyze(`
      import get from 'lodash/get';
      import { chunk as split } from 'lodash/chunk';
      import * as debounce from 'lodash/debounce';
    `);

    expect(recorded).toEqual([
      { key: 'lodash/', names: ['default'], request: 'lodash/get' },
      { key: 'lodash/', names: ['chunk'], request: 'lodash/chunk' },
    ]);
    expect(unsafe).toEqual([{ key: 'lodash/', request: 'lodash/debounce' }]);
  });

  it('ignores imports of shared entries that do not enable tree shaking', () => {
    const { recorded, unsafe } = analyze(`
      import { value } from 'plain';
      import * as Plain from 'plain';
    `);

    expect(recorded).toEqual([]);
    expect(unsafe).toEqual([]);
  });

  it('ignores generated federation wrappers', () => {
    for (const id of [
      '/repo/node_modules/__mf__virtual/antd__prebuild__.js',
      '/repo/node_modules/__mf__virtual/antd__loadShare__.js',
    ]) {
      expect(analyze(`import { Button } from 'antd'`, id)).toEqual({
        recorded: [],
        unsafe: [],
      });
    }
  });

  it('marks all configured tree-shaken shares as full when syntax cannot be parsed', () => {
    const { recorded, unsafe } = analyze(`const view = <div />;`);

    expect(recorded).toEqual([]);
    expect(unsafe).toEqual([
      { key: 'antd', request: '*' },
      { key: 'lodash/', request: '*' },
    ]);
  });

  it('ignores unrelated dynamic imports and accepts import attributes', () => {
    const { recorded, unsafe } = analyze(`
      import { Button } from 'antd' with { type: 'javascript' };
      import('./local-module.js');
      import(dynamicRequest);
    `);

    expect(recorded).toEqual([{ key: 'antd', names: ['Button'], request: 'antd' }]);
    expect(unsafe).toEqual([]);
  });
});

describe('tree-shaking export usage state', () => {
  beforeEach(() => {
    resetTreeShakingExports();
    setTreeShakingBuildMode(true);
  });

  it('unions configured exports with inferred exports, deduplicates, and sorts them', () => {
    const shareItem = createShareItem({
      mode: 'runtime-infer',
      usedExports: ['Input', 'Button'],
    });
    recordTreeShakingExports('antd', ['Button', 'Alert'], 'antd');

    expect(getTreeShakingExportUsage('antd', shareItem, 'antd')).toEqual({
      kind: 'exports',
      usedExports: ['Alert', 'Button', 'Input'],
    });
  });

  it('preserves full-bundle state even when configured exports exist', () => {
    const shareItem = createShareItem({
      mode: 'runtime-infer',
      usedExports: ['Button'],
    });
    recordTreeShakingExports('antd', ['Input'], 'antd');
    markTreeShakingPackageUnsafe('antd', 'antd');

    expect(getTreeShakingExportUsage('antd', shareItem, 'antd')).toEqual({ kind: 'full' });
  });

  it('distinguishes an analyzed empty export list from unknown analysis', () => {
    const shareItem = createShareItem({ mode: 'runtime-infer' });

    expect(getTreeShakingExportUsage('antd', shareItem, 'antd')).toEqual({
      kind: 'unknown',
    });
    recordTreeShakingExports('antd', [], 'antd');
    expect(getTreeShakingExportUsage('antd', shareItem, 'antd')).toEqual({
      kind: 'exports',
      usedExports: [],
    });
  });

  it('does not leak exports or unsafe state between concrete subpath requests', () => {
    recordTreeShakingExports('lodash/', ['default'], 'lodash/get');
    recordTreeShakingExports('lodash/', ['chunk'], 'lodash/chunk');
    markTreeShakingPackageUnsafe('lodash/', 'lodash/debounce');

    expect(getTreeShakingExportUsage('lodash/get', lodashPrefixShare, 'lodash/')).toEqual({
      kind: 'exports',
      usedExports: ['default'],
    });
    expect(getTreeShakingExportUsage('lodash/chunk', lodashPrefixShare, 'lodash/')).toEqual({
      kind: 'exports',
      usedExports: ['chunk'],
    });
    expect(getTreeShakingExportUsage('lodash/debounce', lodashPrefixShare, 'lodash/')).toEqual({
      kind: 'full',
    });
    expect(getTreeShakingExportUsage('lodash/map', lodashPrefixShare, 'lodash/')).toEqual({
      kind: 'unknown',
    });
  });

  it('applies wildcard full-bundle state to every request under that share key', () => {
    markTreeShakingPackageUnsafe('lodash/', '*');

    expect(getTreeShakingExportUsage('lodash/get', lodashPrefixShare, 'lodash/')).toEqual({
      kind: 'full',
    });
    expect(getTreeShakingExportUsage('lodash/chunk', lodashPrefixShare, 'lodash/')).toEqual({
      kind: 'full',
    });
    expect(getTreeShakingExportUsage('antd', antdShare)).toEqual({ kind: 'unknown' });
  });

  it('can find a concrete request without an explicit share key for compatibility', () => {
    recordTreeShakingExports('lodash/', ['default'], 'lodash/get');
    expect(getTreeShakingExportUsage('lodash/get', lodashPrefixShare)).toEqual({
      kind: 'exports',
      usedExports: ['default'],
    });
  });

  it('returns no analysis outside build mode or without tree-shaking config', () => {
    recordTreeShakingExports('antd', ['Button'], 'antd');
    setTreeShakingBuildMode(false);
    expect(getTreeShakingExportUsage('antd', antdShare, 'antd')).toBeUndefined();

    setTreeShakingBuildMode(true);
    expect(getTreeShakingExportUsage('plain', notTreeShakenShare, 'plain')).toBeUndefined();
  });

  it('keeps the legacy array accessor for callers that have not migrated yet', () => {
    recordTreeShakingExports('antd', ['Button'], 'antd');
    expect(getTreeShakingUsedExports('antd', antdShare, 'antd')).toEqual(['Button']);

    markTreeShakingPackageUnsafe('antd', 'antd');
    expect(getTreeShakingUsedExports('antd', antdShare, 'antd')).toBeUndefined();
  });
});

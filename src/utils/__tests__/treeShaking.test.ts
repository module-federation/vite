import { beforeEach, describe, expect, it } from 'vitest';
import type {
  NormalizedModuleFederationOptions,
  NormalizedShared,
  ShareItem,
  TreeShakingConfig,
} from '../normalizeModuleFederationOptions';
import {
  collectTreeShakingImports,
  getSharedExportUsage,
  getTreeShakingExportUsage,
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

// Tree-shaking state is keyed by the options object; one instance stands in for a federation() call.
const federationOptions = {} as NormalizedModuleFederationOptions;

const antdShare = createShareItem({ mode: 'runtime-infer' });
const lodashPrefixShare = createShareItem({ mode: 'runtime-infer' });
const notTreeShakenShare = createShareItem();
const hostProvidedBaseShare = createShareItem();
const hostProvidedShare: ShareItem = {
  ...hostProvidedBaseShare,
  name: 'host-only',
  shareConfig: {
    ...hostProvidedBaseShare.shareConfig,
    import: false,
  },
};

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

type RecordedUsage = { key: string; names: readonly string[]; request?: string };
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

  it('waits for asynchronous resolution before completing export analysis', async () => {
    const recorded: RecordedUsage[] = [];
    const unsafe: UnsafeUsage[] = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const analysis = collectTreeShakingImports(
      `import { Button } from 'antd'; export * from 'lodash/get';`,
      '/repo/src/App.js',
      createShared(),
      async (source, shared) => {
        await pending;
        return findSharedKey(source, shared);
      },
      (key, names, request) => recorded.push({ key, names, request }),
      (key, request) => unsafe.push({ key, request })
    );
    expect(recorded).toEqual([]);
    expect(unsafe).toEqual([]);
    release();
    await analysis;
    expect(recorded).toEqual([{ key: 'antd', names: ['Button'], request: 'antd' }]);
    expect(unsafe).toEqual([{ key: 'lodash/', request: 'lodash/get' }]);
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

  it('collects host-provided import:false exports without a tree-shaking option', () => {
    const recorded: RecordedUsage[] = [];
    const unsafe: UnsafeUsage[] = [];
    const shared: NormalizedShared = { 'host-only': hostProvidedShare };

    collectTreeShakingImports(
      `import { value2, value1 as first } from 'host-only';`,
      '/repo/src/App.js',
      shared,
      findSharedKey,
      (key, names, request) => recorded.push({ key, names, request }),
      (key, request) => unsafe.push({ key, request })
    );

    expect(recorded).toEqual([
      {
        key: 'host-only',
        names: ['value2', 'value1'],
        request: 'host-only',
      },
    ]);
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
    resetTreeShakingExports(federationOptions);
    setTreeShakingBuildMode(true, federationOptions);
  });

  it('unions configured exports with inferred exports, deduplicates, and sorts them', () => {
    const shareItem = createShareItem({
      mode: 'runtime-infer',
      usedExports: ['Input', 'Button'],
    });
    recordTreeShakingExports('antd', ['Button', 'Alert'], 'antd', federationOptions);

    expect(getTreeShakingExportUsage('antd', shareItem, 'antd', federationOptions)).toEqual({
      kind: 'exports',
      usedExports: ['Alert', 'Button', 'Input'],
    });
  });

  it('preserves full-bundle state even when configured exports exist', () => {
    const shareItem = createShareItem({
      mode: 'runtime-infer',
      usedExports: ['Button'],
    });
    recordTreeShakingExports('antd', ['Input'], 'antd', federationOptions);
    markTreeShakingPackageUnsafe('antd', 'antd', federationOptions);

    expect(getTreeShakingExportUsage('antd', shareItem, 'antd', federationOptions)).toEqual({
      kind: 'full',
    });
  });

  it('distinguishes an analyzed empty export list from unknown analysis', () => {
    const shareItem = createShareItem({ mode: 'runtime-infer' });

    expect(getTreeShakingExportUsage('antd', shareItem, 'antd', federationOptions)).toEqual({
      kind: 'unknown',
    });
    recordTreeShakingExports('antd', [], 'antd', federationOptions);
    expect(getTreeShakingExportUsage('antd', shareItem, 'antd', federationOptions)).toEqual({
      kind: 'exports',
      usedExports: [],
    });
  });

  it('does not leak exports or unsafe state between concrete subpath requests', () => {
    recordTreeShakingExports('lodash/', ['default'], 'lodash/get', federationOptions);
    recordTreeShakingExports('lodash/', ['chunk'], 'lodash/chunk', federationOptions);
    markTreeShakingPackageUnsafe('lodash/', 'lodash/debounce', federationOptions);

    expect(
      getTreeShakingExportUsage('lodash/get', lodashPrefixShare, 'lodash/', federationOptions)
    ).toEqual({
      kind: 'exports',
      usedExports: ['default'],
    });
    expect(
      getTreeShakingExportUsage('lodash/chunk', lodashPrefixShare, 'lodash/', federationOptions)
    ).toEqual({
      kind: 'exports',
      usedExports: ['chunk'],
    });
    expect(
      getTreeShakingExportUsage('lodash/debounce', lodashPrefixShare, 'lodash/', federationOptions)
    ).toEqual({
      kind: 'full',
    });
    expect(
      getTreeShakingExportUsage('lodash/map', lodashPrefixShare, 'lodash/', federationOptions)
    ).toEqual({
      kind: 'unknown',
    });
  });

  it('applies wildcard full-bundle state to every request under that share key', () => {
    markTreeShakingPackageUnsafe('lodash/', '*', federationOptions);

    expect(
      getTreeShakingExportUsage('lodash/get', lodashPrefixShare, 'lodash/', federationOptions)
    ).toEqual({
      kind: 'full',
    });
    expect(
      getTreeShakingExportUsage('lodash/chunk', lodashPrefixShare, 'lodash/', federationOptions)
    ).toEqual({
      kind: 'full',
    });
    expect(getTreeShakingExportUsage('antd', antdShare, undefined, federationOptions)).toEqual({
      kind: 'unknown',
    });
  });

  it('can find a concrete request without an explicit share key for compatibility', () => {
    recordTreeShakingExports('lodash/', ['default'], 'lodash/get', federationOptions);
    expect(
      getTreeShakingExportUsage('lodash/get', lodashPrefixShare, undefined, federationOptions)
    ).toEqual({
      kind: 'exports',
      usedExports: ['default'],
    });
  });

  it('returns no analysis outside build mode or without tree-shaking config', () => {
    recordTreeShakingExports('antd', ['Button'], 'antd', federationOptions);
    setTreeShakingBuildMode(false, federationOptions);
    expect(getTreeShakingExportUsage('antd', antdShare, 'antd', federationOptions)).toBeUndefined();

    setTreeShakingBuildMode(true, federationOptions);
    expect(
      getTreeShakingExportUsage('plain', notTreeShakenShare, 'plain', federationOptions)
    ).toBeUndefined();
  });

  it('exposes inferred usage for import:false without enabling provider tree shaking', () => {
    recordTreeShakingExports('host-only', ['value2', 'value1'], 'host-only', federationOptions);

    expect(
      getSharedExportUsage('host-only', hostProvidedShare, 'host-only', federationOptions)
    ).toEqual({
      kind: 'exports',
      usedExports: ['value1', 'value2'],
    });
    expect(
      getTreeShakingExportUsage('host-only', hostProvidedShare, 'host-only', federationOptions)
    ).toBeUndefined();
  });

  it('returns export usage for tree-shaken packages', () => {
    recordTreeShakingExports('antd', ['Button'], 'antd', federationOptions);
    expect(getTreeShakingExportUsage('antd', antdShare, 'antd', federationOptions)).toEqual({
      kind: 'exports',
      usedExports: ['Button'],
    });

    markTreeShakingPackageUnsafe('antd', 'antd', federationOptions);
    expect(getTreeShakingExportUsage('antd', antdShare, 'antd', federationOptions)).toEqual({
      kind: 'full',
    });
  });
});

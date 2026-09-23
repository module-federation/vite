import { describe, expect, it, vi } from 'vitest';
import type { NormalizedModuleFederationOptions } from '../../utils/normalizeModuleFederationOptions';
import { pluginLazyConsumeOnlyShares } from '../pluginLazyConsumeOnlyShares';

const { getNormalizeShareItem, getUsedShares } = vi.hoisted(() => ({
  getNormalizeShareItem: vi.fn(),
  getUsedShares: vi.fn(),
}));

vi.mock('../../utils/normalizeModuleFederationOptions', () => ({
  getNormalizeShareItem,
}));

vi.mock('../../virtualModules/virtualRemoteEntry', () => ({
  LAZY_CONSUME_ONLY_SHARES_PLACEHOLDER: '__MF_LAZY_CONSUME_ONLY_SHARES__',
  getLocalSharedImportMapPath: ({ internalName }: { internalName: string }) =>
    `virtual:mf-localSharedImportMap:${internalName}__mf_owner__1`,
  getUsedShares,
}));

vi.mock('../../virtualModules/virtualShared_preBuild', () => ({
  getLoadShareModulePath: (
    pkg: string,
    _isRolldown: boolean,
    { internalName }: { internalName: string }
  ) => `virtual:mf:${internalName}__loadShare__${pkg}__loadShare__.js`,
}));

vi.mock('../../virtualModules/virtualRuntimeInitStatus', () => ({
  getRuntimeInitGlobalKey: (ownerImportId: string) => `__mf_init__${ownerImportId}__`,
  getRuntimeInitStatusImportId: ({ internalName }: { internalName: string }) =>
    `virtual:mf:${internalName}__runtimeInit__.js`,
}));

const shareConfigs: Record<string, Record<string, unknown>> = {
  react: { import: false, singleton: true },
  'lodash-es': { import: false, singleton: true },
  'eager-only': { import: false, eager: true },
  local: { singleton: true },
};

getUsedShares.mockImplementation(() => new Set(Object.keys(shareConfigs)));
getNormalizeShareItem.mockImplementation((key: string) => ({ shareConfig: shareConfigs[key] }));

const options = {
  name: 'remote',
  internalName: 'remote',
  exposes: { './App': { import: './src/App.jsx' } },
} as unknown as NormalizedModuleFederationOptions;

const wrapper = (pkg: string) => `\0virtual:mf:remote__loadShare__${pkg}__loadShare__.js`;

function chunk(
  fileName: string,
  overrides: Partial<{
    isEntry: boolean;
    facadeModuleId: string | null;
    moduleIds: string[];
    imports: string[];
    dynamicImports: string[];
  }> = {}
) {
  return {
    type: 'chunk' as const,
    fileName,
    modules: {},
    isEntry: false,
    facadeModuleId: null,
    moduleIds: [],
    imports: [],
    dynamicImports: [],
    ...overrides,
  };
}

function createChunks() {
  return {
    'remoteEntry.js': chunk('remoteEntry.js', {
      isEntry: true,
      facadeModuleId: '\0virtual:mf:remote__remoteEntry__',
      moduleIds: ['\0virtual:mf:remote__remoteEntry__'],
      imports: ['assets/importMap-!~{001}~.js'],
      dynamicImports: ['assets/App-!~{002}~.js'],
    }),
    'assets/importMap-!~{001}~.js': chunk('assets/importMap-!~{001}~.js', {
      moduleIds: ['\0virtual:mf-localSharedImportMap:remote__mf_owner__1'],
    }),
    'assets/App-!~{002}~.js': chunk('assets/App-!~{002}~.js', {
      facadeModuleId: '/root/src/App.jsx',
      moduleIds: ['/root/src/App.jsx', wrapper('react'), wrapper('eager-only')],
      dynamicImports: ['assets/GridPanel-!~{003}~.js'],
    }),
    'assets/GridPanel-!~{003}~.js': chunk('assets/GridPanel-!~{003}~.js', {
      facadeModuleId: '/root/src/GridPanel.jsx',
      moduleIds: ['/root/src/GridPanel.jsx', wrapper('lodash-es'), wrapper('local')],
    }),
  };
}

function renderChunk(
  chunks: Record<string, ReturnType<typeof chunk>>,
  fileName: string,
  code: string,
  context: Record<string, unknown> = {}
) {
  const plugin = pluginLazyConsumeOnlyShares(options);
  (plugin.configResolved as (config: unknown) => void).call(plugin, { root: '/root' });
  const hook = plugin.renderChunk as (
    this: unknown,
    code: string,
    chunk: unknown,
    outputOptions: unknown,
    meta: unknown
  ) => { code: string; map: { mappings: string; sources: string[] } } | null;
  return hook.call(context, code, chunks[fileName], {}, { chunks });
}

describe('pluginLazyConsumeOnlyShares', () => {
  it('wraps the dynamic import of a chunk that needs a lazily reached consume-only share', () => {
    const chunks = createChunks();
    const code = `const GridPanel = lazy(() => __vitePreload(() => import("./GridPanel-!~{003}~.js"), __VITE_PRELOAD__));\n`;

    const result = renderChunk(chunks, 'assets/App-!~{002}~.js', code);

    expect(result?.code).toContain(
      '__mfLoadLazyShares_remote(["lodash-es"]).then(() => import("./GridPanel-!~{003}~.js"))'
    );
    expect(result?.code).toContain('function __mfLoadLazyShares_remote(names)');
    expect(result?.code).toContain(
      'globalThis["__mf_init__virtual:mf:remote__runtimeInit__.js__"]'
    );
    expect(result?.code).toContain('state.loadLazyShares(names)');
    expect(result?.map.sources).toEqual(['assets/App-!~{002}~.js']);
    expect(result?.map.mappings).not.toBe('');
  });

  it('publishes the lazy share list into the local shared import map', () => {
    const chunks = createChunks();
    const code = `const __mfLazyShares = "__MF_LAZY_CONSUME_ONLY_SHARES__";\n`;

    const result = renderChunk(chunks, 'assets/importMap-!~{001}~.js', code);

    expect(result?.code).toBe(`const __mfLazyShares = ["lodash-es"];\n`);
    expect(result?.code).not.toContain('__mfLoadLazyShares_remote');
  });

  it('keeps shares that an entry or an expose reaches statically out of the lazy list', () => {
    const chunks = createChunks();
    // The expose now imports the grid panel statically, so lodash-es is a startup share.
    chunks['assets/App-!~{002}~.js'].imports = ['assets/GridPanel-!~{003}~.js'];
    chunks['assets/App-!~{002}~.js'].dynamicImports = [];

    expect(
      renderChunk(
        chunks,
        'assets/importMap-!~{001}~.js',
        `const __mfLazyShares = "__MF_LAZY_CONSUME_ONLY_SHARES__";\n`
      )
    ).toBeNull();
  });

  it('wraps an import() that carries comments around its specifier', () => {
    const chunks = createChunks();
    const code = `import(/* webpackChunkName: "grid" */ './GridPanel-!~{003}~.js' /* trailing */);\n`;

    const result = renderChunk(chunks, 'assets/App-!~{002}~.js', code);

    expect(result?.code).toContain(
      `__mfLoadLazyShares_remote(["lodash-es"]).then(() => import(/* webpackChunkName: "grid" */ './GridPanel-!~{003}~.js' /* trailing */))`
    );
  });

  it('ignores an import() spelled inside a string or a comment', () => {
    const chunks = createChunks();
    const code = `// import("./GridPanel-!~{003}~.js")\nconst text = 'import("./GridPanel-!~{003}~.js")';\n`;

    expect(renderChunk(chunks, 'assets/App-!~{002}~.js', code)).toBeNull();
  });

  it('leaves chunks whose dynamic imports need no lazy share untouched', () => {
    const chunks = createChunks();
    const code = `import("./App-!~{002}~.js");\n`;

    expect(renderChunk(chunks, 'remoteEntry.js', code)).toBeNull();
  });

  it('gives each federation instance its own helper in a chunk both rewrite', () => {
    const chunks = createChunks();
    const otherWrapper = '\0virtual:mf:other__loadShare__lodash-es__loadShare__.js';
    chunks['assets/GridPanel-!~{003}~.js'].moduleIds.push(otherWrapper);
    const code = `import("./GridPanel-!~{003}~.js");\n`;

    const first = renderChunk(chunks, 'assets/App-!~{002}~.js', code);
    const other = pluginLazyConsumeOnlyShares({
      ...options,
      name: 'other',
      internalName: 'other',
    } as NormalizedModuleFederationOptions);
    (other.configResolved as (config: unknown) => void).call(other, { root: '/root' });
    const hook = other.renderChunk as (
      this: unknown,
      code: string,
      chunk: unknown,
      outputOptions: unknown,
      meta: unknown
    ) => { code: string } | null;
    const second = hook.call({}, first!.code, chunks['assets/App-!~{002}~.js'], {}, { chunks });

    expect(second?.code).toContain('function __mfLoadLazyShares_remote(names)');
    expect(second?.code).toContain('function __mfLoadLazyShares_other(names)');
    // The later plugin wraps the import expression the earlier one already wrapped.
    expect(second?.code).toContain(
      '__mfLoadLazyShares_remote(["lodash-es"]).then(() => __mfLoadLazyShares_other(["lodash-es"]).then(() => import("./GridPanel-!~{003}~.js")))'
    );
  });

  it('does nothing for a server build or a container without exposes', () => {
    const chunks = createChunks();
    const code = `import("./GridPanel-!~{003}~.js");\n`;

    expect(
      renderChunk(chunks, 'assets/App-!~{002}~.js', code, {
        environment: { name: 'ssr', config: { consumer: 'server' } },
      })
    ).toBeNull();

    const hostPlugin = pluginLazyConsumeOnlyShares({
      ...options,
      exposes: {},
    } as NormalizedModuleFederationOptions);
    const hook = hostPlugin.renderChunk as (
      this: unknown,
      code: string,
      chunk: unknown,
      outputOptions: unknown,
      meta: unknown
    ) => unknown;
    expect(hook.call({}, code, chunks['assets/App-!~{002}~.js'], {}, { chunks })).toBeNull();
  });
});

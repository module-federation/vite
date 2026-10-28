import type {
  EmitFile,
  NormalizedOutputOptions,
  OutputBundle,
  OutputChunk,
  PluginContext,
} from 'rollup';
import { createContext, runInContext } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callHook } from '../../utils/__tests__/viteHookHelpers';
import pluginVarRemoteEntry from '../pluginVarRemoteEntry';

const { getNormalizeModuleFederationOptions } = vi.hoisted(() => ({
  getNormalizeModuleFederationOptions: vi.fn(),
}));

vi.mock('../../utils/normalizeModuleFederationOptions', () => ({
  getNormalizeModuleFederationOptions,
}));

type TestPluginContext = Pick<PluginContext, 'emitFile'>;
type GenerateBundleHook = (
  this: PluginContext,
  outputOptions: NormalizedOutputOptions,
  bundle: OutputBundle,
  isWrite: boolean
) => void | Promise<void>;

const chunk = (fileName: string, name: string): OutputChunk => ({
  type: 'chunk',
  fileName,
  name,
  facadeModuleId: null,
  code: '',
  modules: {},
  dynamicImports: [],
  implicitlyLoadedBefore: [],
  importedBindings: {},
  imports: [],
  isDynamicEntry: false,
  isEntry: false,
  isImplicitEntry: false,
  moduleIds: [],
  referencedFiles: [],
  exports: [],
  map: null,
  preliminaryFileName: fileName,
  sourcemapFileName: null,
});

async function generateSource(name = 'basicRemote', filename = 'remoteEntry.js') {
  getNormalizeModuleFederationOptions.mockReturnValue({
    name,
    filename,
    varFilename: 'remoteEntry.var.js',
  });
  const [, plugin] = pluginVarRemoteEntry();
  let source = '';
  const emitFile: EmitFile = (asset) => {
    if ('source' in asset) source = String(asset.source);
    return 'id';
  };
  await callHook(
    plugin.generateBundle as unknown as GenerateBundleHook | { handler: GenerateBundleHook },
    { emitFile } as TestPluginContext as PluginContext,
    {} as NormalizedOutputOptions,
    { [filename]: chunk(filename, 'remoteEntry') },
    false
  );
  return source;
}

describe('pluginVarRemoteEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getNormalizeModuleFederationOptions.mockReturnValue({
      name: 'basicRemote',
      filename: 'remoteEntry.js',
      varFilename: 'remoteEntry.var.js',
    });
  });

  it('wraps the container remoteEntry, not a same-named expose chunk', async () => {
    const [, buildPlugin] = pluginVarRemoteEntry();
    const emitted: Record<string, string> = {};
    const emitFile: EmitFile = (asset) => {
      if ('fileName' in asset && typeof asset.fileName === 'string' && 'source' in asset) {
        emitted[asset.fileName] =
          typeof asset.source === 'string'
            ? asset.source
            : Buffer.from(asset.source ?? new Uint8Array()).toString('utf8');
        return `id:${asset.fileName}`;
      }
      return 'id:unknown';
    };
    const bundle = {
      'assets/remoteEntry-abc123.js': chunk('assets/remoteEntry-abc123.js', 'remoteEntry'),
      'remoteEntry.js': chunk('remoteEntry.js', 'remoteEntry'),
    } as OutputBundle;

    await callHook(
      buildPlugin.generateBundle as unknown as GenerateBundleHook | { handler: GenerateBundleHook },
      { emitFile } as TestPluginContext as PluginContext,
      {} as NormalizedOutputOptions,
      bundle,
      false
    );

    expect(emitted['remoteEntry.var.js']).toContain(
      'const entry = getScriptUrl() + "remoteEntry.js"'
    );
    expect(emitted['remoteEntry.var.js']).not.toContain('assets/remoteEntry-abc123.js');
  });

  it('keeps var entries bound to each federation instance options', async () => {
    const optionsA = {
      name: 'tenantA',
      filename: 'remote-a.js',
      varFilename: 'remote-a.var.js',
    } as never;
    const optionsB = {
      name: 'tenantB',
      filename: 'remote-b.js',
      varFilename: 'remote-b.var.js',
    } as never;
    const [, buildPluginA] = pluginVarRemoteEntry(optionsA);
    const [, buildPluginB] = pluginVarRemoteEntry(optionsB);
    getNormalizeModuleFederationOptions.mockReturnValue({
      name: 'wrongGlobal',
      filename: 'wrong.js',
      varFilename: 'wrong.var.js',
    });
    const emitted: Record<string, string> = {};
    const emitFile: EmitFile = (asset) => {
      if ('fileName' in asset && typeof asset.fileName === 'string' && 'source' in asset) {
        emitted[asset.fileName] = String(asset.source);
      }
      return 'id';
    };
    const bundle = {
      'remote-a.js': chunk('remote-a.js', 'remoteEntry'),
      'remote-b.js': chunk('remote-b.js', 'remoteEntry'),
    } as OutputBundle;

    for (const plugin of [buildPluginA, buildPluginB]) {
      await callHook(
        plugin.generateBundle as unknown as GenerateBundleHook | { handler: GenerateBundleHook },
        { emitFile } as TestPluginContext as PluginContext,
        {} as NormalizedOutputOptions,
        bundle,
        false
      );
    }

    expect(emitted['remote-a.var.js']).toContain('const name = "tenantA";');
    expect(emitted['remote-a.var.js']).toContain('getScriptUrl() + "remote-a.js"');
    expect(emitted['remote-a.var.js']).not.toContain('wrongGlobal');
    expect(emitted['remote-b.var.js']).toContain('const name = "tenantB";');
    expect(emitted['remote-b.var.js']).toContain('getScriptUrl() + "remote-b.js"');
    expect(emitted['remote-b.var.js']).not.toContain('wrongGlobal');
  });

  it('registers a fresh container with the legacy global variable binding', async () => {
    const source = await generateSource();
    const context = createContext({
      document: { currentScript: { src: 'https://example.test/assets/remoteEntry.var.js' } },
    });
    runInContext(source, context);
    const container = context.basicRemote;
    runInContext(source, context);
    expect(context.basicRemote).toBe(container);
    expect(context.basicRemote.get).toBeTypeOf('function');
    expect(context.basicRemote.init).toBeTypeOf('function');
    expect(runInContext('basicRemote === globalThis.basicRemote', context)).toBe(true);
    expect(Object.hasOwn(context, 'name')).toBe(false);
  });

  it('forwards get and init to the ESM entry next to the wrapper', async () => {
    const source = await generateSource();
    const imports: string[] = [];
    const context = createContext({
      document: { currentScript: { src: 'https://example.test/assets/remoteEntry.var.js' } },
    });
    runInContext(source, context, {
      importModuleDynamically: async (specifier) => {
        imports.push(specifier);
        return import(
          'data:text/javascript,' +
            encodeURIComponent(
              'export const get = x => "get:" + x; export const init = x => "init:" + x;'
            )
        );
      },
    });
    await expect(context.basicRemote.get('./message')).resolves.toBe('get:./message');
    await expect(context.basicRemote.init('scope')).resolves.toBe('init:scope');
    expect(imports).toEqual([
      'https://example.test/assets/remoteEntry.js',
      'https://example.test/assets/remoteEntry.js',
    ]);
  });

  it.each(['top', 'self', 'parent', 'window', 'document', 'location', 'frames'])(
    'does not overwrite an existing browser global %s',
    async (name) => {
      const source = await generateSource(name);
      const original = {};
      const context = createContext({ [name]: original });
      expect(() => runInContext(source, context)).toThrow(
        `Cannot register var remote "${name}" because the global already exists`
      );
      expect(context[name]).toBe(original);
    }
  );

  it.each(['globalThis', 'Object', 'NaN', 'undefined', 'Infinity'])(
    'rejects the existing built-in global %s',
    async (name) => {
      const source = await generateSource(name);
      const context = createContext({});
      const original = runInContext(`globalThis[${JSON.stringify(name)}]`, context);
      expect(() => runInContext(source, context)).toThrow('Choose a different federation name');
      expect(runInContext(`globalThis[${JSON.stringify(name)}]`, context)).toBe(original);
    }
  );

  it.each([null, false, 0, ''])('preserves an existing falsy global (%s)', async (value) => {
    const source = await generateSource();
    const context = createContext({ basicRemote: value });
    expect(() => runInContext(source, context)).toThrow('the global already exists');
    expect(context.basicRemote).toBe(value);
  });

  it('rejects the falsy browser global length', async () => {
    const source = await generateSource('length');
    const context = createContext({});
    Object.defineProperty(context, 'length', { get: () => 0, configurable: true });
    expect(() => runInContext(source, context)).toThrow('the global already exists');
    expect(context.length).toBe(0);
  });

  it('allows a writable undefined slot used by a var declaration', async () => {
    const source = await generateSource();
    const context = createContext({
      basicRemote: undefined,
      document: { currentScript: { src: 'https://example.test/remoteEntry.var.js' } },
    });
    runInContext(source, context);
    expect(context.basicRemote.get).toBeTypeOf('function');
    expect(context.basicRemote.init).toBeTypeOf('function');
  });

  it('registers a reserved-word name without emitting a var declaration', async () => {
    const source = await generateSource('class');
    expect(source).not.toContain('var class');
    const context = createContext({
      document: { currentScript: { src: 'https://example.test/remoteEntry.var.js' } },
    });
    runInContext(source, context);
    expect(context.class.init).toBeTypeOf('function');
  });

  it('rejects an existing readonly undefined slot', async () => {
    const source = await generateSource();
    const context = createContext({});
    Object.defineProperty(context, 'basicRemote', { value: undefined, writable: false });
    expect(() => runInContext(source, context)).toThrow('the global already exists');
    expect(context.basicRemote).toBeUndefined();
  });

  it('does not treat an undefined property for a non-identifier name as a hoisted var slot', async () => {
    const source = await generateSource('remote-with-dashes');
    const context = createContext({ 'remote-with-dashes': undefined });
    expect(() => runInContext(source, context)).toThrow('the global already exists');
    expect(context['remote-with-dashes']).toBeUndefined();
  });

  it('rejects an existing lexical binding before registering the container', async () => {
    const source = await generateSource();
    const context = createContext({});
    runInContext('const basicRemote = "existing lexical binding";', context);
    expect(() => runInContext(source, context)).toThrow('already been declared');
    expect(runInContext('basicRemote', context)).toBe('existing lexical binding');
    expect(Object.hasOwn(context, 'basicRemote')).toBe(false);
  });

  it.each(['constructor', 'toString'])(
    'does not register a container when var hoisting shadows inherited %s',
    async (name) => {
      const source = await generateSource(name);
      const context = createContext({});
      const original = runInContext(
        `Object.getPrototypeOf(globalThis)[${JSON.stringify(name)}]`,
        context
      );
      expect(() => runInContext(source, context)).toThrow('the global already exists');
      expect(
        runInContext(`Object.getPrototypeOf(globalThis)[${JSON.stringify(name)}]`, context)
      ).toBe(original);
      expect(context[name]?.init).not.toBeTypeOf('function');
    }
  );

  it('does not invoke an existing global getter or setter, including location navigation', async () => {
    const source = await generateSource('location');
    const get = vi.fn();
    const set = vi.fn();
    const context = createContext({});
    Object.defineProperty(context, 'location', { get, set, configurable: true });
    expect(() => runInContext(source, context)).toThrow('the global already exists');
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it('preserves an existing container and supports loading the wrapper twice', async () => {
    const source = await generateSource();
    const existing = { get: vi.fn(), init: vi.fn() };
    const context = createContext({ basicRemote: existing });
    runInContext(source, context);
    runInContext(source, context);
    expect(context.basicRemote).toBe(existing);
    expect(existing.get).not.toHaveBeenCalled();
    expect(existing.init).not.toHaveBeenCalled();
  });

  it('preserves preloaded containers whose get and init exports use getters', async () => {
    const source = await generateSource();
    const existing = Object.defineProperties(
      {},
      {
        get: { get: () => vi.fn() },
        init: { get: () => vi.fn() },
      }
    );
    const context = createContext({ basicRemote: existing });
    runInContext(source, context);
    expect(context.basicRemote).toBe(existing);
  });

  it('serializes names and filenames without inserting them as executable source', async () => {
    const name = "remote-with-'quotes</script>\u2028";
    const source = await generateSource(name, "remote'entry.js");
    const context = createContext({
      document: { currentScript: { src: 'https://example.test/remoteEntry.var.js' } },
    });
    runInContext(source, context);
    expect(context[name].get).toBeTypeOf('function');
    expect(context[name].init).toBeTypeOf('function');
    expect(source).not.toContain('</script>');
  });
});

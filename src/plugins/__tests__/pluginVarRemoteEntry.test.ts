import type {
  EmitFile,
  NormalizedOutputOptions,
  OutputBundle,
  OutputChunk,
  PluginContext,
} from 'rollup';
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
      "const entry = getScriptUrl() + 'remoteEntry.js'"
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

    expect(emitted['remote-a.var.js']).toContain('var tenantA;');
    expect(emitted['remote-a.var.js']).toContain("getScriptUrl() + 'remote-a.js'");
    expect(emitted['remote-a.var.js']).not.toContain('wrongGlobal');
    expect(emitted['remote-b.var.js']).toContain('var tenantB;');
    expect(emitted['remote-b.var.js']).toContain("getScriptUrl() + 'remote-b.js'");
    expect(emitted['remote-b.var.js']).not.toContain('wrongGlobal');
  });
});

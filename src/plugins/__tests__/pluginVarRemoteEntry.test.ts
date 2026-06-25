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
});

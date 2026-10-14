import { describe, expect, it } from 'vitest';
import type { NormalizedModuleFederationOptions } from '../../utils/normalizeModuleFederationOptions';
import { getVirtualExposesId } from '../../virtualModules/virtualExposes';
import { getRemoteEntryId } from '../../virtualModules/virtualRemoteEntry';
import { pluginAssetRequestContextImports } from '../pluginAssetRequestContextImports';

const options = {
  name: 'remote',
  internalName: 'remote',
  filename: 'remoteEntry.js',
  exposes: { './App': { import: './src/App.jsx' } },
} as unknown as NormalizedModuleFederationOptions;

function chunk(fileName: string, moduleIds: string[], facadeModuleId: string | null = null) {
  return { type: 'chunk' as const, fileName, modules: {}, facadeModuleId, moduleIds };
}

function renderChunk(
  code: string,
  renderedChunk: ReturnType<typeof chunk>,
  pluginOptions = options,
  context: Record<string, unknown> = {}
) {
  const plugin = pluginAssetRequestContextImports(pluginOptions);
  (plugin.configResolved as (config: unknown) => void).call(plugin, {});
  const hook = plugin.renderChunk as (
    this: unknown,
    code: string,
    chunk: unknown
  ) => { code: string; map: { mappings: string } } | null;
  return hook.call(context, code, renderedChunk);
}

const helper = '__mfAssetRequestContextImport_remote';

describe('pluginAssetRequestContextImports', () => {
  it('routes dynamic imports of the remote entry chunk through the assetRequestContext helper', () => {
    const code = [
      'const a = () => import("./assets/App.js");',
      "const b = () => import(/* @vite-ignore */ './assets/share.js');",
      'const s = "import(\\"./not-code.js\\")";',
    ].join('\n');
    const result = renderChunk(
      code,
      chunk('remoteEntry.js', [getRemoteEntryId(options)], getRemoteEntryId(options))
    );

    expect(result?.code).toContain(
      `const a = () => ${helper}(import.meta.url, "./assets/App.js", () => import("./assets/App.js"));`
    );
    expect(result?.code).toContain(
      `${helper}(import.meta.url, "./assets/share.js", () => import(/* @vite-ignore */ './assets/share.js'))`
    );
    expect(result?.code).toContain('const s = "import(\\"./not-code.js\\")";');
    expect(result?.code).toContain(`function ${helper}(base, spec, load)`);
    expect(result?.map.mappings).toBeTruthy();
  });

  it('rewrites the chunk holding the exposes module', () => {
    const result = renderChunk(
      'export default { "./App": () => import("./App.js") };',
      chunk('assets/exposes.js', ['/src/other.js', `\0${getVirtualExposesId(options)}`])
    );
    expect(result?.code).toContain(`${helper}(import.meta.url, "./App.js"`);
  });

  it('leaves other chunks, containers without exposes and server builds alone', () => {
    const code = 'const a = () => import("./lazy.js");';
    expect(renderChunk(code, chunk('assets/app.js', ['/src/app.js']))).toBeNull();
    expect(
      renderChunk(code, chunk('remoteEntry.js', [getRemoteEntryId(options)]), {
        ...options,
        exposes: {},
      } as NormalizedModuleFederationOptions)
    ).toBeNull();
    expect(
      renderChunk(code, chunk('remoteEntry.js', [getRemoteEntryId(options)]), options, {
        environment: { config: { consumer: 'server' } },
      })
    ).toBeNull();
  });

  it('returns null when the chunk has no dynamic imports', () => {
    expect(
      renderChunk('export const x = 1;', chunk('remoteEntry.js', [getRemoteEntryId(options)]))
    ).toBeNull();
  });
});

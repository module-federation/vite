import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'url';
import type { Plugin } from 'vite';
import { normalizePathForImport } from '../utils/buildPaths';
import {
  addCssAssetsToAllExports,
  collectCssAssets,
  createEmptyAssetMap,
  processModuleAssets,
} from '../utils/cssModuleHelpers';
import { mapCodeToCodeWithSourcemap } from '../utils/mapCodeToCodeWithSourcemap';
import type { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { filterId, resolvePublicPath } from '../utils/pathNormalization';
import {
  generateExposes,
  generateHostAutoInitCode,
  generateRemoteEntry,
  getExposesCssMapPlaceholder,
  getHostAutoInitPath,
} from '../virtualModules';
import { parsePromise } from './pluginModuleParseEnd';

interface ProxyRemoteEntryParams {
  options: NormalizedModuleFederationOptions;
  remoteEntryId: string;
  virtualExposesId: string;
}

function resolveDevHashEntryFileName(fileName: string) {
  if (!fileName.includes('[hash')) return fileName;

  const normalized = fileName.replace(/(?:[._-]?\[hash(?::\d+)?\])/g, '');
  const baseName = path.basename(normalized);

  return path.extname(baseName) ? normalized : `${normalized}.js`;
}

export default function ({
  options,
  remoteEntryId,
  virtualExposesId,
}: ProxyRemoteEntryParams): Plugin {
  let viteConfig: any, _command: string, root: string;
  let exposeRemoteDependencies: Record<string, string[]> = {};
  let exposeRemoteDependenciesDirty = true;
  let refreshPromise: Promise<void> | undefined;
  let dependencyInvalidationVersion = 0;

  function isRemoteImport(source: string): boolean {
    return Object.keys(options.remotes).some(
      (name) => source === name || source.startsWith(name + '/')
    );
  }

  function collectImportSources(code: string): string[] {
    const sources = new Set<string>();
    const importRe =
      /(?:^|[;\n\r])\s*import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

    for (const match of code.matchAll(importRe)) {
      const source = match[1] || match[2];
      if (source) sources.add(source);
    }

    return Array.from(sources).sort();
  }

  function shouldScanResolvedImport(id: string): boolean {
    if (!id || id.includes('\0')) return false;
    if (id.includes('/node_modules/') || id.includes('\\node_modules\\')) return false;
    return /\.(?:[cm]?[jt]sx?|vue|svelte)(?:\?|$)/.test(id);
  }

  async function collectRemoteDependencies(
    ctx: { resolve: Plugin['resolveId'] },
    id: string,
    seen = new Set<string>()
  ): Promise<string[]> {
    if (seen.has(id) || !shouldScanResolvedImport(id)) return [];
    seen.add(id);

    let code: string;
    try {
      code = readFileSync(id, 'utf8');
    } catch {
      return [];
    }

    const dependencies = new Set<string>();
    for (const source of collectImportSources(code)) {
      if (isRemoteImport(source)) {
        dependencies.add(source);
        continue;
      }

      const resolved = await (ctx as any).resolve(source, id);
      if (!resolved?.id || !shouldScanResolvedImport(resolved.id)) continue;
      for (const dependency of await collectRemoteDependencies(ctx, resolved.id, seen)) {
        dependencies.add(dependency);
      }
    }

    return Array.from(dependencies).sort();
  }

  async function refreshExposeRemoteDependencies(ctx: { resolve: Plugin['resolveId'] }) {
    if (!exposeRemoteDependenciesDirty) return;
    if (!refreshPromise) {
      const refreshVersion = dependencyInvalidationVersion;
      refreshPromise = (async () => {
        const next: Record<string, string[]> = {};
        for (const [exposeKey, expose] of Object.entries(options.exposes)) {
          const resolved = await (ctx as any).resolve(expose.import);
          next[exposeKey] = resolved?.id ? await collectRemoteDependencies(ctx, resolved.id) : [];
        }
        exposeRemoteDependencies = next;
        if (refreshVersion === dependencyInvalidationVersion) {
          exposeRemoteDependenciesDirty = false;
        }
      })().finally(() => {
        refreshPromise = undefined;
      });
    }
    await refreshPromise;
  }

  function invalidateExposeRemoteDependencies() {
    exposeRemoteDependenciesDirty = true;
    dependencyInvalidationVersion += 1;
  }

  return {
    name: 'proxyRemoteEntry',
    enforce: 'post',
    configResolved(config) {
      viteConfig = config;
      root = config.root;
    },
    config(_config, { command }) {
      _command = command;
    },
    async buildStart() {
      await refreshExposeRemoteDependencies(this);
      // Emit each exposed module as a chunk entry so the bundler properly
      // code-splits shared dependencies away from the main entry's side effects.
      // Without this, the bundler may merge exposed modules into the main entry
      // chunk, causing the host to execute the remote's bootstrap code (e.g.
      // createApp().mount()) when loading an exposed component.
      if (_command !== 'build') return;
      for (const expose of Object.values(options.exposes)) {
        const resolved = await this.resolve(expose.import);
        if (resolved) {
          this.emitFile({
            type: 'chunk',
            id: resolved.id,
          });
        }
      }
    },
    watchChange() {
      invalidateExposeRemoteDependencies();
    },
    handleHotUpdate() {
      invalidateExposeRemoteDependencies();
    },
    async resolveId(id: string, importer?: string) {
      if (id === remoteEntryId) {
        return remoteEntryId;
      }
      if (id === virtualExposesId) {
        return virtualExposesId;
      }
      if (_command === 'serve' && id.includes(getHostAutoInitPath())) {
        return id;
      }
      // When the virtual remote entry imports a bare specifier (e.g. a runtime
      // plugin like "@module-federation/dts-plugin/dynamic-remote-type-hints-plugin"),
      // Vite cannot resolve it from the consumer project root under strict package
      // managers (pnpm) because it is a transitive dependency.  Re-resolve from
      // this package's location so Vite uses the correct ESM entry point.
      if (
        importer === remoteEntryId &&
        !id.startsWith('.') &&
        !id.startsWith('/') &&
        !id.startsWith('\0') &&
        !id.startsWith('virtual:')
      ) {
        const importPath =
          typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url);
        const resolved = await this.resolve(id, importPath, { skipSelf: true });
        if (resolved) return resolved;
      }
    },
    async load(id: string) {
      if (id === remoteEntryId) {
        return parsePromise.then((_) => generateRemoteEntry(options, virtualExposesId, _command));
      }
      if (id === virtualExposesId) {
        await refreshExposeRemoteDependencies(this);
        return generateExposes(options, exposeRemoteDependencies, _command);
      }
      if (_command === 'serve' && id.includes(getHostAutoInitPath())) {
        return id;
      }
    },
    async transform(code: string, id: string) {
      const transformedCode = await (async () => {
        if (!filterId(id)) return;
        if (id.includes(remoteEntryId)) {
          return parsePromise.then((_) => generateRemoteEntry(options, virtualExposesId, _command));
        }
        if (id === virtualExposesId) {
          await refreshExposeRemoteDependencies(this);
          return generateExposes(options, exposeRemoteDependencies, _command);
        }
        if (id.includes(getHostAutoInitPath())) {
          if (_command === 'serve') {
            const host =
              typeof viteConfig.server?.host === 'string' && viteConfig.server.host !== '0.0.0.0'
                ? viteConfig.server.host
                : 'localhost';
            const resolvedPublicPath = resolvePublicPath(options, viteConfig.base);
            const publicPath = JSON.stringify(
              (resolvedPublicPath === 'auto' ? '/' : resolvedPublicPath) +
                resolveDevHashEntryFileName(options.filename)
            );
            const fallbackOrigin = `//${host}:${viteConfig.server?.port}`;
            const ssrRemoteEntry =
              'data:text/javascript,' +
              encodeURIComponent(
                'export async function init(){return {loadRemote:async()=>({}),loadShare:async()=>({})}}'
              );
            return `
          const origin = typeof window !== 'undefined' && (${!options.ignoreOrigin}) ? window.origin : ${JSON.stringify(fallbackOrigin)};
          const remoteEntryImport = typeof window !== 'undefined' ? origin + ${publicPath} : ${JSON.stringify(ssrRemoteEntry)};
          ${generateHostAutoInitCode('remoteEntryImport', 'serve')}
        `;
          }
          return code;
        }
      })();

      return mapCodeToCodeWithSourcemap(transformedCode);
    },
    generateBundle(_, bundle) {
      if (_command !== 'build') return;

      const filesMap: Record<
        string,
        {
          js: { sync: string[]; async: string[] };
          css: { sync: string[]; async: string[] };
        }
      > = {};
      const exposeEntries = Object.entries(options.exposes);
      const allCssAssets = options.bundleAllCSS ? collectCssAssets(bundle) : new Set<string>();

      processModuleAssets(
        bundle,
        filesMap,
        (modulePath) => {
          const matchedExpose = exposeEntries.find(([_, exposeOptions]) => {
            const exposePath = path.resolve(root, exposeOptions.import);
            return modulePath === exposePath;
          });

          return matchedExpose?.[1].import;
        },
        { root, stripKnownJsExtensions: true }
      );

      if (options.bundleAllCSS) {
        addCssAssetsToAllExports(filesMap, allCssAssets);
      }

      const ensureRelativeImportPath = (fromFile: string, toFile: string) => {
        let relativePath = normalizePathForImport(path.relative(path.dirname(fromFile), toFile));
        if (!relativePath.startsWith('.')) {
          relativePath = `./${relativePath}`;
        }
        return relativePath;
      };

      const placeholderValue = getExposesCssMapPlaceholder();
      const placeholderPatterns = [
        JSON.stringify(placeholderValue),
        `'${placeholderValue}'`,
        `\`${placeholderValue}\``,
      ];
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk' || !file.code.includes(placeholderValue)) continue;

        // virtualExposes can be wrapped into helper chunks, so patch every chunk
        // that still carries the placeholder.
        const cssAssetMap = exposeEntries.reduce<Record<string, string[]>>(
          (acc, [exposeKey, expose]) => {
            const assets = filesMap[expose.import] || createEmptyAssetMap();
            acc[exposeKey] = [...assets.css.sync, ...assets.css.async].map((cssAsset) =>
              ensureRelativeImportPath(file.fileName, cssAsset)
            );
            return acc;
          },
          {}
        );

        for (const placeholderPattern of placeholderPatterns) {
          file.code = file.code.replace(placeholderPattern, JSON.stringify(cssAssetMap));
        }
      }
    },
  };
}

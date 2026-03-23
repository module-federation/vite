import { createFilter } from '@rollup/pluginutils';
import { IncomingMessage, ServerResponse } from 'http';
import * as path from 'pathe';
import { fileURLToPath } from 'url';
import { Logger, ModuleNode, Plugin, ViteDevServer } from 'vite';
import {
  addCssAssetsToAllExports,
  collectCssAssets,
  createEmptyAssetMap,
  processModuleAssets,
} from '../utils/cssModuleHelpers';
import { matchesMfHmrUrl, onServerReady } from '../utils/hmrUtils';
import { formatModuleFederationMessage } from '../utils/logger';
import { mapCodeToCodeWithSourcemap } from '../utils/mapCodeToCodeWithSourcemap';
import { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { resolvePublicPath } from '../utils/publicPath';
import {
  generateExposes,
  generateRemoteEntry,
  getExposesCssMapPlaceholder,
  getHostAutoInitPath,
} from '../virtualModules';
import { parsePromise } from './pluginModuleParseEnd';

const filter: (id: string) => boolean = createFilter();
const MAX_WALK_DEPTH = 50;

interface ProxyRemoteEntryParams {
  options: NormalizedModuleFederationOptions;
  remoteEntryId: string;
  virtualExposesId: string;
}

export default function ({
  options,
  remoteEntryId,
  virtualExposesId,
}: ProxyRemoteEntryParams): Plugin {
  let viteConfig: any, _command: string, root: string;
  const clients = new Set<ServerResponse>();
  let exposeFiles = new Set<string>();
  let server: ViteDevServer;
  let logger: Logger;
  let pathsResolved = false;

  function broadcast(data: object) {
    const message = `data: ${JSON.stringify(data)}\n\n`;
    clients.forEach((client) => {
      try {
        client.write(message);
      } catch {
        clients.delete(client);
      }
    });
  }

  return {
    name: 'proxyRemoteEntry',
    enforce: 'post',
    configResolved(config) {
      viteConfig = config;
      logger = config.logger;
      root = config.root;
    },
    config(config, { command }) {
      _command = command;
    },
    configureServer(_server) {
      server = _server;

      // Serve-only federation HMR channel: remotes publish expose changes to hosts over SSE.
      _server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (!matchesMfHmrUrl(req.url, _server.config.base)) {
          next();
          return;
        }

        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Accept',
          });
          res.end();
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
          'X-Accel-Buffering': 'no',
        });
        res.write(`data: ${JSON.stringify({ type: 'mf:connected', name: options.name })}\n\n`);

        clients.add(res);
        req.on('close', () => {
          clients.delete(res);
        });
      });

      return () => {
        onServerReady(_server, resolveExposePaths);
      };
    },
    async buildStart() {
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
    async handleHotUpdate(ctx) {
      // Serve-only: notify hosts only when the changed file belongs to an exposed module graph.
      if (_command !== 'serve') return;
      if (!pathsResolved) {
        await resolveExposePaths();
      }
      if (!isExposedChange(ctx.file, ctx.modules)) return;

      logger.info(formatModuleFederationMessage(`Exposed modules changed in "${options.name}"`));

      if (clients.size > 0) {
        broadcast({
          type: 'mf:update',
          remoteName: options.name,
          timestamp: Date.now(),
        });
      }

      const exposeModule = server.moduleGraph.getModuleById(virtualExposesId);
      if (!exposeModule) return;

      return [...ctx.modules, exposeModule];
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
    load(id: string) {
      if (id === remoteEntryId) {
        return parsePromise.then((_) => generateRemoteEntry(options, virtualExposesId, _command));
      }
      if (id === virtualExposesId) {
        return generateExposes(options, _command);
      }
      if (_command === 'serve' && id.includes(getHostAutoInitPath())) {
        return id;
      }
    },
    transform(code: string, id: string) {
      const transformedCode = (() => {
        if (!filter(id)) return;
        if (id.includes(remoteEntryId)) {
          return parsePromise.then((_) => generateRemoteEntry(options, virtualExposesId, _command));
        }
        if (id === virtualExposesId) {
          return generateExposes(options, _command);
        }
        if (id.includes(getHostAutoInitPath())) {
          if (_command === 'serve') {
            const host =
              typeof viteConfig.server?.host === 'string' && viteConfig.server.host !== '0.0.0.0'
                ? viteConfig.server.host
                : 'localhost';
            const publicPath = JSON.stringify(
              resolvePublicPath(options, viteConfig.base) + options.filename
            );
            return `
          if (typeof window !== 'undefined') {
            const origin = (${!options.ignoreOrigin}) ? window.origin : "//${host}:${viteConfig.server?.port}"
            const remoteEntryPromise = await import(origin + ${publicPath})
            // __tla only serves as a hack for vite-plugin-top-level-await.
            Promise.resolve(remoteEntryPromise)
            .then(remoteEntry => {
              return Promise.resolve(remoteEntry.__tla)
                .then(remoteEntry.init).catch(remoteEntry.init)
            })
          }
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

      processModuleAssets(bundle, filesMap, (modulePath) => {
        const absoluteModulePath = path.resolve(root, modulePath);
        const matchedExpose = exposeEntries.find(([_, exposeOptions]) => {
          const exposePath = path.resolve(root, exposeOptions.import);
          if (absoluteModulePath === exposePath) {
            return true;
          }

          const stripKnownJsExt = (filePath: string) => {
            const ext = path.extname(filePath);
            return ['.ts', '.tsx', '.jsx', '.mjs', '.cjs'].includes(ext)
              ? path.join(path.dirname(filePath), path.basename(filePath, ext))
              : filePath;
          };

          return stripKnownJsExt(absoluteModulePath) === stripKnownJsExt(exposePath);
        });

        return matchedExpose?.[1].import;
      });

      if (options.bundleAllCSS) {
        addCssAssetsToAllExports(filesMap, allCssAssets);
      }

      const ensureRelativeImportPath = (fromFile: string, toFile: string) => {
        let relativePath = path.relative(path.dirname(fromFile), toFile);
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

  async function resolveExposePaths() {
    if (!server) return;

    const nextFiles = new Set<string>();

    for (const exposeItem of Object.values(options.exposes)) {
      const absPath = await resolveExposePath(exposeItem.import);
      if (!absPath) continue;
      nextFiles.add(absPath);
    }

    exposeFiles = nextFiles;
    pathsResolved = true;
  }

  async function resolveExposePath(id: string): Promise<string | null> {
    try {
      const resolved = await server.pluginContainer.resolveId(id);
      if (resolved?.id) {
        return normalizeFilePath(resolved.id);
      }
    } catch {}

    if (id.startsWith('.')) {
      return normalizeFilePath(path.resolve(server.config.root, id));
    }

    if (id.startsWith('/')) {
      return normalizeFilePath(path.resolve(server.config.root, id.slice(1)));
    }

    return null;
  }

  function isExposedChange(changedFile: string, modules: readonly ModuleNode[]): boolean {
    if (exposeFiles.has(normalizeFilePath(changedFile))) return true;

    const visited = new Set<string>();
    for (let i = 0; i < modules.length; i++) {
      if (walkImporters(modules[i], visited, 0)) return true;
    }

    return false;
  }

  function walkImporters(mod: ModuleNode, visited: Set<string>, depth: number): boolean {
    if (depth > MAX_WALK_DEPTH) return false;

    const modId = mod.file || mod.id;
    if (!modId) return false;

    const normalizedId = normalizeFilePath(modId);
    if (visited.has(normalizedId)) return false;
    visited.add(normalizedId);

    if (exposeFiles.has(normalizedId)) return true;

    for (const importer of mod.importers) {
      if (walkImporters(importer, visited, depth + 1)) return true;
    }

    return false;
  }
}

function normalizeFilePath(id: string): string {
  return path.resolve(id.split('?')[0]);
}

import { IncomingMessage, ServerResponse } from 'http';
import * as path from 'pathe';
import { Plugin, ViteDevServer, ModuleNode } from 'vite';
import { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { createMfLogger, MfLogger } from '../utils/logger';
import { onServerReady } from '../utils/hmrUtils';

const MAX_WALK_DEPTH = 50;

/**
 * HMR Remote Plugin
 *
 * Runs on the remote app's dev server. Exposes an SSE endpoint (/__mf_hmr)
 * that broadcasts which exposed modules changed when source files are edited.
 */
export default function pluginHmrRemote(options: NormalizedModuleFederationOptions): Plugin {
  const { exposes } = options;

  // No exposes = nothing to broadcast
  if (!exposes || Object.keys(exposes).length === 0) {
    return { name: 'module-federation-hmr-remote' };
  }

  const clients = new Set<ServerResponse>();
  // Map of absolute file path → expose keys (e.g., './Cart')
  let exposeFileMap = new Map<string, string[]>();
  let server: ViteDevServer;
  let log: MfLogger;
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
    name: 'module-federation-hmr-remote',
    apply: 'serve',

    configureServer(_server) {
      server = _server;
      log = createMfLogger(_server.config.logger);

      // SSE endpoint — register BEFORE internal middleware
      _server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        // Handle CORS preflight
        if (req.method === 'OPTIONS' && req.url === '/__mf_hmr') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Accept',
          });
          res.end();
          return;
        }

        if (req.url !== '/__mf_hmr') return next();

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
          'X-Accel-Buffering': 'no',
        });

        // Send initial connection event
        res.write(`data: ${JSON.stringify({ type: 'mf:connected', name: options.name })}\n\n`);

        clients.add(res);
        log.info(`HMR client connected (${clients.size} total)`);

        req.on('close', () => {
          clients.delete(res);
        });
      });

      // Post-hook: resolve expose paths once server is ready
      return () => {
        onServerReady(_server, resolveExposePaths);
      };
    },

    async handleHotUpdate(ctx) {
      const { file, modules } = ctx;

      // Lazily resolve expose paths if not done yet
      if (!pathsResolved) {
        await resolveExposePaths();
      }

      // Always check for affected exposes, even if no SSE clients are connected.
      // This keeps the logic testable and logs useful info.
      const affectedExposes = findAffectedExposes(file, modules);
      if (affectedExposes.length === 0) return;

      log.info(`Exposed modules changed: ${affectedExposes.join(', ')}`);

      if (clients.size > 0) {
        broadcast({
          type: 'mf:update',
          remoteName: options.name,
          exposes: affectedExposes,
          timestamp: Date.now(),
        });
      }

      // Return undefined to let Vite handle the remote's own HMR normally
    },
  };

  async function resolveExposePaths() {
    if (!server) return;
    const newMap = new Map<string, string[]>();

    for (const [exposeKey, exposeItem] of Object.entries(exposes)) {
      try {
        const resolved = await server.pluginContainer.resolveId(exposeItem.import);
        if (resolved) {
          const absPath = path.resolve(resolved.id);
          const existing = newMap.get(absPath) || [];
          existing.push(exposeKey);
          newMap.set(absPath, existing);
        }
      } catch {
        // Expose path couldn't be resolved — skip
      }
    }

    exposeFileMap = newMap;
    pathsResolved = true;

    if (newMap.size > 0) {
      log.info(`Watching ${newMap.size} exposed module entries for HMR`);
    }
  }

  function findAffectedExposes(changedFile: string, modules: readonly ModuleNode[]): string[] {
    const affected = new Set<string>();
    const absChangedFile = path.resolve(changedFile);

    // Direct match: the changed file IS an exposed entry
    const directMatch = exposeFileMap.get(absChangedFile);
    if (directMatch) {
      directMatch.forEach((key) => affected.add(key));
    }

    // Walk importers to find if the changed file is a transitive dependency
    // of any exposed module
    const visited = new Set<string>();

    for (let i = 0; i < modules.length; i++) {
      walkImporters(modules[i], visited, affected, 0);
    }

    return Array.from(affected);
  }

  function walkImporters(
    mod: ModuleNode,
    visited: Set<string>,
    affected: Set<string>,
    depth: number
  ) {
    if (depth > MAX_WALK_DEPTH) return;

    const modId = mod.file || mod.id;
    if (!modId || visited.has(modId)) return;
    visited.add(modId);

    const absPath = path.resolve(modId);
    const exposeKeys = exposeFileMap.get(absPath);
    if (exposeKeys) {
      exposeKeys.forEach((key) => affected.add(key));
    }

    mod.importers.forEach((importer) => {
      walkImporters(importer, visited, affected, depth + 1);
    });
  }
}

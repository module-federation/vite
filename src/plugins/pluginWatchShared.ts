import { createFilter } from '@rollup/pluginutils';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import path from 'pathe';
import type { Plugin } from 'vite';

const fileHashes = new Map<string, string>();

function hasContentChanged(filePath: string): boolean {
  let currentHash: string | null = null;
  try {
    currentHash = createHash('sha256').update(readFileSync(filePath)).digest('hex');
  } catch {}

  const previousHash = fileHashes.get(filePath);
  if (currentHash !== null) {
    fileHashes.set(filePath, currentHash);
  } else {
    fileHashes.delete(filePath);
  }

  return currentHash !== previousHash;
}

export function pluginWatchShared(watchShared: string[] = []): Plugin {
  let restartGlobs: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  return {
    name: 'module-federation-watch-shared',
    apply: 'serve',
    config(config) {
      if (!watchShared.length) return;
      // Vite disables globbing by default in chokidar.
      // Re-enable it so watcher.add() supports glob patterns.
      config.server ??= {};
      config.server.watch ??= {};
      config.server.watch.disableGlobbing = false;
    },
    configResolved(config) {
      restartGlobs = watchShared.map((g) =>
        path.isAbsolute(g) ? g : path.posix.join(config.root, g)
      );
    },
    configureServer(server) {
      if (!restartGlobs.length) return;

      const isMatch = createFilter(restartGlobs);
      server.watcher.add(restartGlobs);

      function onFileChange(file: string) {
        if (!isMatch(file) || !hasContentChanged(file)) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          console.log(`\n[module-federation] Shared file changed: ${file}. Restarting server...\n`);
          server.restart();
        }, 500);
      }

      server.watcher.on('add', onFileChange);
      server.watcher.on('change', onFileChange);
      server.watcher.on('unlink', onFileChange);
    },
  };
}

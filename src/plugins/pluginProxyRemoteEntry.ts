import { createFilter } from '@rollup/pluginutils';
import { fileURLToPath } from 'url';
import { Plugin } from 'vite';
import { mapCodeToCodeWithSourcemap } from '../utils/mapCodeToCodeWithSourcemap';
import { getNormalizeModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { resolvePublicPath } from '../utils/publicPath';
import {
  generateExposes,
  generateRemoteEntry,
  getHostAutoInitPath,
  REMOTE_ENTRY_ID,
  VIRTUAL_EXPOSES,
} from '../virtualModules';
import { parsePromise } from './pluginModuleParseEnd';

const filter: (id: string) => boolean = createFilter();

export default function (): Plugin {
  let viteConfig: any, _command: string;
  return {
    name: 'proxyRemoteEntry',
    enforce: 'post',
    configResolved(config) {
      viteConfig = config;
    },
    config(config, { command }) {
      _command = command;
    },
    async resolveId(id: string, importer?: string) {
      if (id === REMOTE_ENTRY_ID) {
        return REMOTE_ENTRY_ID;
      }
      if (id === VIRTUAL_EXPOSES) {
        return VIRTUAL_EXPOSES;
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
        importer === REMOTE_ENTRY_ID &&
        !id.startsWith('.') &&
        !id.startsWith('/') &&
        !id.startsWith('\0') &&
        !id.startsWith('virtual:')
      ) {
        const importPath =
          typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url);
        const resolved = await this.resolve(id, __filename, { skipSelf: true });
        if (resolved) return resolved;
      }
    },
    load(id: string) {
      if (id === REMOTE_ENTRY_ID) {
        return parsePromise.then((_) =>
          generateRemoteEntry(getNormalizeModuleFederationOptions(), _command)
        );
      }
      if (id === VIRTUAL_EXPOSES) {
        return generateExposes();
      }
      if (_command === 'serve' && id.includes(getHostAutoInitPath())) {
        return id;
      }
    },
    transform(code: string, id: string) {
      const transformedCode = (() => {
        if (!filter(id)) return;
        if (id.includes(REMOTE_ENTRY_ID)) {
          return parsePromise.then((_) =>
            generateRemoteEntry(getNormalizeModuleFederationOptions(), _command)
          );
        }
        if (id === VIRTUAL_EXPOSES) {
          return generateExposes();
        }
        if (id.includes(getHostAutoInitPath())) {
          const options = getNormalizeModuleFederationOptions();
          if (_command === 'serve') {
            const host =
              typeof viteConfig.server?.host === 'string' && viteConfig.server.host !== '0.0.0.0'
                ? viteConfig.server.host
                : 'localhost';
            const publicPath = JSON.stringify(
              resolvePublicPath(options, viteConfig.base) + options.filename
            );
            return `
          const origin = (window && ${!options.ignoreOrigin}) ? window.origin : "//${host}:${viteConfig.server?.port}"
          const remoteEntryPromise = await import(origin + ${publicPath})
          // __tla only serves as a hack for vite-plugin-top-level-await.
          Promise.resolve(remoteEntryPromise)
          .then(remoteEntry => {
            return Promise.resolve(remoteEntry.__tla)
              .then(remoteEntry.init).catch(remoteEntry.init)
          })
          `;
          }
          return code;
        }
      })();

      return mapCodeToCodeWithSourcemap(transformedCode);
    },
  };
}

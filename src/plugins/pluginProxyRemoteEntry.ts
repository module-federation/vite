import { createFilter } from '@rollup/pluginutils';
import { fileURLToPath } from 'url';
import { Plugin } from 'vite';
import { mapCodeToCodeWithSourcemap } from '../utils/mapCodeToCodeWithSourcemap';
import { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { resolvePublicPath } from '../utils/publicPath';
import { generateExposes, generateRemoteEntry, getHostAutoInitPath } from '../virtualModules';
import { parsePromise } from './pluginModuleParseEnd';

const filter: (id: string) => boolean = createFilter();

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
        return parsePromise.then((_) => generateRemoteEntry(options, virtualExposesId));
      }
      if (id === virtualExposesId) {
        return generateExposes(options);
      }
      if (_command === 'serve' && id.includes(getHostAutoInitPath())) {
        return id;
      }
    },
    transform(code: string, id: string) {
      const transformedCode = (() => {
        if (!filter(id)) return;
        if (id.includes(remoteEntryId)) {
          return parsePromise.then((_) => generateRemoteEntry(options, virtualExposesId));
        }
        if (id === virtualExposesId) {
          return generateExposes(options);
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

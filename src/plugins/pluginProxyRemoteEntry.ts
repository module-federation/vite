import { createFilter } from '@rollup/pluginutils';
import { Plugin } from 'vite';
import { getNormalizeModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
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
    resolveId(id: string) {
      if (id === REMOTE_ENTRY_ID) {
        return REMOTE_ENTRY_ID;
      }
      if (id === VIRTUAL_EXPOSES) {
        return VIRTUAL_EXPOSES;
      }
      if (_command === 'serve' && id.includes(getHostAutoInitPath())) {
        return id;
      }
    },
    load(id: string) {
      if (id === REMOTE_ENTRY_ID) {
        return parsePromise.then((_) => generateRemoteEntry(getNormalizeModuleFederationOptions()));
      }
      if (id === VIRTUAL_EXPOSES) {
        return generateExposes();
      }
      if (_command === 'serve' && id.includes(getHostAutoInitPath())) {
        return id;
      }
    },
    async transform(code: string, id: string) {
      if (!filter(id)) return;
      if (id.includes(REMOTE_ENTRY_ID)) {
        return parsePromise.then((_) => generateRemoteEntry(getNormalizeModuleFederationOptions()));
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
          return `
          const {init} = await import("//${host}:${viteConfig.server?.port}${viteConfig.base + options.filename}")
          init()
          `;
        }
        return code;
      }
    },
  };
}

import { createFilter } from '@rollup/pluginutils';
import { Plugin } from 'vite';
import { getNormalizeModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { generateRemoteEntry, REMOTE_ENTRY_ID } from '../virtualModules';
import { parsePromise } from './pluginModuleParseEnd';

const filter: (id: string) => boolean = createFilter();

export default function (): Plugin {
  return {
    name: 'proxyRemoteEntry',
    enforce: 'post',
    resolveId(id: string) {
      if (id === REMOTE_ENTRY_ID) {
        return REMOTE_ENTRY_ID;
      }
    },
    load(id: string) {
      if (id === REMOTE_ENTRY_ID) {
        return parsePromise.then((_) => generateRemoteEntry(getNormalizeModuleFederationOptions()));
      }
    },
    async transform(code: string, id: string) {
      if (!filter(id)) return;
      if (id.includes(REMOTE_ENTRY_ID)) {
        return parsePromise.then((_) => generateRemoteEntry(getNormalizeModuleFederationOptions()));
      }
    },
  };
}

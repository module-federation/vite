import { createFilter } from '@rollup/pluginutils';
import { Plugin } from 'vite';
import { getNormalizeModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { generateRemoteEntry, generateWrapHostInit, generateWrapRemoteEntry, HOST_AUTO_INIT, REMOTE_ENTRY_ID, WRAP_REMOTE_ENTRY_PATH } from '../virtualModules/virtualRemoteEntry';

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
        return generateRemoteEntry(getNormalizeModuleFederationOptions());
      }
    },
    async transform(code: string, id: string) {
      if (!filter(id)) return;
      if (id === REMOTE_ENTRY_ID) {
        return generateRemoteEntry(getNormalizeModuleFederationOptions());
      }
      if (id.includes(WRAP_REMOTE_ENTRY_PATH)) {
        return generateWrapRemoteEntry();
      }
      if (id.includes(HOST_AUTO_INIT)) {
        return generateWrapHostInit();
      }
    },
  }


}
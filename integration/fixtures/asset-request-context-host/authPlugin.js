// A host plugin written the way the README describes; the token is checked by
// the test's remote server.
import { loadEntryWithRequest } from '@module-federation/vite/assetRequestContext';

const context = {
  consumerId: 'hostApp',
  request: (url, init = {}) =>
    fetch(url, {
      ...init,
      headers: { ...init.headers, Authorization: 'Bearer secret-token' },
    }),
};

export default function authPlugin() {
  return {
    name: 'auth-plugin',
    fetch(url, init) {
      return context.request(url, init);
    },
    async loadEntry({ remoteInfo, remoteEntryExports }) {
      if (remoteEntryExports) return remoteEntryExports;
      if (remoteInfo.type !== 'esm' && remoteInfo.type !== 'module') return undefined;
      return loadEntryWithRequest({
        entry: remoteInfo.entry,
        name: remoteInfo.name,
        request: context.request,
      });
    },
    beforeInitContainer(args) {
      args.remoteEntryInitOptions.assetRequestContext ??= context;
      return args;
    },
  };
}

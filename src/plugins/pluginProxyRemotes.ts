import { createFilter } from '@rollup/pluginutils';
import { Plugin } from 'vite';
import { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { addUsedRemote, getRemoteVirtualModule } from '../virtualModules';
const filter: (id: string) => boolean = createFilter();

export default function (options: NormalizedModuleFederationOptions): Plugin {
  let command: string;
  const { remotes } = options;
  return {
    name: 'proxyRemotes',
    config(config, { command: _command }) {
      command = _command;
      const isRolldown = !!(this as any)?.meta?.rolldownVersion;
      Object.keys(remotes).forEach((key) => {
        const remote = remotes[key];
        (config.resolve as any).alias.push({
          find: new RegExp(`^(${remote.name}(\/.*|$))`),
          replacement: '$1',
          customResolver(source: string) {
            const remoteModule = getRemoteVirtualModule(source, _command, isRolldown);
            addUsedRemote(remote.name, source);
            return remoteModule.getPath();
          },
        });
      });
    },
  };
}

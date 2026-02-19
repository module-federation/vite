import { createFilter } from '@rollup/pluginutils';
import { Plugin } from 'vite';
import { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { addUsedRemote, getRemoteVirtualModule } from '../virtualModules';
const filter: (id: string) => boolean = createFilter();

export default function (options: NormalizedModuleFederationOptions): Plugin[] {
  let command: string;
  const { remotes } = options;
  // Pre-compiled remote patterns, set in config hook of resolveId plugin
  let remotePatterns: { name: string; regex: RegExp }[] = [];
  return [
    {
      name: 'proxyRemotes',
      config(config, { command: _command }) {
        command = _command;
        // In dev mode, use aliases (resolveId can't interfere with Vite pre-bundling).
        // In build mode, aliases are skipped — resolveId handles resolution instead,
        // so that per-environment scoping (applyToEnvironment) works correctly.
        if (_command !== 'build') {
          Object.keys(remotes).forEach((key) => {
            const remote = remotes[key];
            (config.resolve as any).alias.push({
              find: new RegExp(`^(${remote.name}(\/.*|$))`),
              replacement: '$1',
              customResolver(source: string) {
                const remoteModule = getRemoteVirtualModule(source, _command);
                addUsedRemote(remote.name, source);
                return remoteModule.getPath();
              },
            });
          });
        }
      },
    },
    {
      name: 'proxyRemotes:resolve',
      enforce: 'pre',
      apply: 'build',
      config() {
        // Pre-compile remote patterns at config time
        remotePatterns = Object.keys(remotes).map((key) => ({
          name: remotes[key].name,
          regex: new RegExp(`^${remotes[key].name}(\/.*|$)`),
        }));
      },
      resolveId(source) {
        for (const { name, regex } of remotePatterns) {
          if (regex.test(source)) {
            const remoteModule = getRemoteVirtualModule(source, 'build');
            addUsedRemote(name, source);
            return { id: remoteModule.getPath(), syntheticNamedExports: '__moduleExports' };
          }
        }
      },
    } satisfies Plugin,
  ];
}

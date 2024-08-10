import { createFilter } from "@rollup/pluginutils";
import { Plugin } from "vite";
import { NormalizedModuleFederationOptions } from "../utils/normalizeModuleFederationOptions";
import { generateRemotes } from "../virtualModules/virtualRemotes";
const filter: (id: string) => boolean = createFilter();

export default function (options: NormalizedModuleFederationOptions): Plugin {
  let command: string
  const { remotes } = options
  const remotePrefixList = Object.keys(remotes);
  return {
    name: "proxyRemotes",
    config(config, { command: _command }) {
      command = _command
      Object.keys(remotes).forEach((key) => {
        const remote = remotes[key];
        ; (config.resolve as any).alias.push({
          find: new RegExp(`(${remote.name}(\/.*|$)?)`),
          replacement: '$1',
          customResolver(source: string) {
            if (!config.optimizeDeps) config.optimizeDeps = {};
            if (!config.optimizeDeps.needsInterop) config.optimizeDeps.needsInterop = [];
            if (config.optimizeDeps.needsInterop.indexOf(source) === -1)
              config.optimizeDeps.needsInterop.push(source);
            return this.resolve(
              require.resolve('an-empty-js-file') + '?__moduleRemote__=' + encodeURIComponent(source)
            );
          },
        });
      });
    },
    async transform(code: string, id: string) {
      if (!filter(id)) return;
      let [devRemoteModuleName] =
        (remotePrefixList.length &&
          id.match(new RegExp(`\/(${remotePrefixList.join('|')})(\_.*\.js|\.js)`))) ||
        [];
      if (devRemoteModuleName) {
        return generateRemotes(
          devRemoteModuleName.replace('/', '').replace(/_/g, '/').replace('.js', ''),
          command
        );
      }
      let [prodRemoteName] = id.match(/\_\_moduleRemote\_\_=[^&]+/) || [];
      if (prodRemoteName) {
        return generateRemotes(
          decodeURIComponent(prodRemoteName.replace('__moduleRemote__=', '')),
          command
        );
      }
    },
  }
}
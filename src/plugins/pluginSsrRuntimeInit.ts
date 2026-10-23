import { type Plugin, version as viteVersion } from 'vite';
import { findModuleImportSources } from '../utils/htmlEntryUtils';
import { mapCodeToCodeWithSourcemap } from '../utils/mapCodeToCodeWithSourcemap';
import {
  hasRemotes,
  type NormalizedModuleFederationOptions,
} from '../utils/normalizeModuleFederationOptions';
import { isServerContext } from '../utils/remoteConsumerTarget';
import { getSsrCapabilities, isSsrConfig } from '../utils/ssrCapabilities';
import { serializeRuntimeOptions, toSafeJsLiteral } from '../utils/serializeRuntimeOptions';
import { getRuntimePluginSpecifier } from '../utils/runtimePluginSpecifier';
import {
  getHostAutoInitPath,
  getLocalSharedImportMapPath,
  isOwnedHostAutoInitId,
} from '../virtualModules/virtualRemoteEntry';
import {
  getRuntimeInitBootstrapCode,
  getRuntimeInitStatusImportId,
} from '../virtualModules/virtualRuntimeInitStatus';

/** Register the SSR host before application evaluation, without preloading remotes. */
export default function pluginSsrRuntimeInit(options: NormalizedModuleFederationOptions): Plugin[] {
  if (!hasRemotes(options)) return [];
  let command: 'serve' | 'build';
  let legacySsr = false;
  let supported = false;
  const server = (ctx: unknown, ssr?: boolean) =>
    supported && isServerContext(ctx, ssr === true || legacySsr);

  return [
    {
      name: 'module-federation-ssr-runtime-init',
      enforce: 'post',
      config(_config, env) {
        command = env.command;
      },
      configResolved(config) {
        legacySsr = Boolean(config.build.ssr);
        supported = getSsrCapabilities(
          parseInt(viteVersion, 10),
          command,
          true,
          isSsrConfig(config)
        ).enableSsrInitBootstrap;
      },
      resolveId: {
        order: 'pre',
        handler(id, _importer, resolveOptions) {
          if (server(this, resolveOptions.ssr) && id === options.implementation) {
            // The runtime's singleton is module-local. Keep the implementation's
            // original exports, but give each server application its own module.
            return { id: options.implementation, external: false };
          }
        },
      },
      transform(code, id, transformOptions) {
        if (!server(this, transformOptions?.ssr)) return;
        if (isOwnedHostAutoInitId(id, options)) {
          const pluginImports = options.runtimePlugins
            .map(
              (plugin, index) =>
                `import plugin${index} from ${toSafeJsLiteral(getRuntimePluginSpecifier(plugin))};`
            )
            .join('\n');
          const plugins = options.runtimePlugins
            .map(
              (plugin, index) =>
                `plugin${index}(${Array.isArray(plugin) ? serializeRuntimeOptions(plugin[1]) : ''})`
            )
            .join(',');
          return {
            code: `
            import { init } from ${toSafeJsLiteral(options.implementation)};
            import { usedShared, usedRemotes } from ${toSafeJsLiteral(getLocalSharedImportMapPath(options))};
            ${pluginImports}
            ${getRuntimeInitBootstrapCode(false, getRuntimeInitStatusImportId(options))}
            globalThis[globalKey].ssrInitStarted = true;
            const runtime = init({
              name: ${toSafeJsLiteral(options.name)},
              remotes: usedRemotes,
              shared: usedShared,
              plugins: [${plugins}],
              shareStrategy: ${toSafeJsLiteral(options.shareStrategy)},
            });
            const hostInitPromise = Promise.resolve(runtime);
            globalThis[globalKey].initResolve(runtime);
            function initHost() { return hostInitPromise; }
            export { initHost, hostInitPromise };
          `,
            map: null,
          };
        }
        if (
          !(command === 'build' && this.getModuleInfo(id)?.isEntry) &&
          !findModuleImportSources(code).includes('@module-federation/runtime')
        )
          return;
        const injection = `import ${toSafeJsLiteral(getHostAutoInitPath(options))};\n`;
        if (code.includes(injection.trim())) return;
        return mapCodeToCodeWithSourcemap(injection + code);
      },
    },
  ];
}

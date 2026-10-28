import type { Plugin } from 'vite';
import { findRemoteEntryFile } from '../utils/bundleHelpers';
import { createModuleFederationError, mfWarn } from '../utils/logger';
import { toSafeJsLiteral } from '../utils/serializeRuntimeOptions';
import {
  getNormalizeModuleFederationOptions,
  type NormalizedModuleFederationOptions,
} from '../utils/normalizeModuleFederationOptions';

const VarRemoteEntry = (providedOptions?: NormalizedModuleFederationOptions): Plugin[] => {
  const mfOptions = providedOptions ?? getNormalizeModuleFederationOptions();
  const { name, varFilename, filename } = mfOptions;

  let viteConfig: any;

  return [
    {
      name: 'module-federation-var-remote-entry',
      apply: 'serve',
      /**
       * Stores resolved Vite config for later use
       */
      /**
       * Finalizes configuration after all plugins are resolved
       * @param config - Fully resolved Vite config
       */
      configResolved(config) {
        viteConfig = config;
      },
      /**
       * Configures dev server middleware to handle varRemoteEntry requests
       * @param server - Vite dev server instance
       */
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (!varFilename) {
            next();
            return;
          }
          if (
            req.url?.replace(/\?.*/, '') === (viteConfig.base + varFilename).replace(/^\/?/, '/')
          ) {
            res.setHeader('Content-Type', 'text/javascript');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.end(generateVarRemoteEntry(filename));
          } else {
            next();
          }
        });
      },
    },
    {
      name: 'module-federation-var-remote-entry',
      enforce: 'post',
      /**
       * Initial plugin configuration
       * @param config - Vite config object
       * @param command - Current Vite command (serve/build)
       */
      config(config) {
        if (!config.build) config.build = {};
      },
      configResolved(config) {
        viteConfig = config;
      },
      /**
       * Generates the module federation "var" remote entry file
       * @param options - Rollup output options
       * @param bundle - Generated bundle assets
       */
      async generateBundle(_options, bundle) {
        if (!varFilename) return;
        // Vite bundledDev generates bundles in serve too; the dev middleware
        // above already serves the var entry.
        if (viteConfig?.command === 'serve') return;

        const isValidName = isValidVarName(name);

        if (!isValidName) {
          mfWarn(
            `Provided remote name "${name}" is not valid for "var" remoteEntry type, thus it's placed in globalThis['${name}'].\nIt may cause problems, so you would better want to use valid var name (see https://www.w3schools.com/js/js_variables.asp).`
          );
        }

        const remoteEntryFile = findRemoteEntryFile(mfOptions.filename, bundle);

        if (!remoteEntryFile)
          throw createModuleFederationError(
            `Couldn't find a remoteEntry chunk file for ${mfOptions.filename}, can't generate varRemoteEntry file`
          );

        this.emitFile({
          type: 'asset',
          fileName: varFilename,
          source: generateVarRemoteEntry(remoteEntryFile),
        });
      },
    },
  ];

  function isValidVarName(name: string) {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
  }

  /**
   * Generates the final "var" remote entry file
   * @param remoteEntryFile - Path to esm remote entry file
   * @returns Complete "var" remoteEntry.js file source
   */
  function generateVarRemoteEntry(remoteEntryFile: string) {
    const { name, varFilename } = mfOptions;
    const isValidName = isValidVarName(name);

    return `
  ${isValidName ? `var ${name};` : ''}
  (function (global) {
    const name = ${toSafeJsLiteral(name)};
    const descriptor = Object.getOwnPropertyDescriptor(global, name);
    const prototype = Object.getPrototypeOf(global);
    const emptyVarSlot = ${isValidName} && descriptor && 'value' in descriptor && descriptor.value === undefined && descriptor.writable && !(prototype && name in prototype);
    if (name in global && !emptyVarSlot) {
      const existing = descriptor && 'value' in descriptor ? descriptor.value : undefined;
      if (existing && typeof existing.get === 'function' && typeof existing.init === 'function') {
        return;
      }
      throw new Error('[Module Federation] Cannot register var remote "' + name + '" because the global already exists. Choose a different federation name or use an ESM remote.');
    }

    function getScriptUrl() {
      const currentScript = document.currentScript;
      if (!currentScript) {
        console.error(${toSafeJsLiteral(`[Module Federation] ${varFilename} script should be called from sync <script> tag (document.currentScript is undefined)`)})
        return '/';
      }
      return document.currentScript.src.replace(/\\/[^/]*$/, '/');
    }

    const entry = getScriptUrl() + ${toSafeJsLiteral(remoteEntryFile)};

    global[name] = {
      get: (...args) => import(entry).then(m => m.get(...args)),
      init: (...args) => import(entry).then(m => m.init(...args)),
    };
  })(globalThis);
  `;
  }
};

export default VarRemoteEntry;

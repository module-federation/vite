import { Plugin } from 'vite';
import { findRemoteEntryFile } from '../utils/bundleHelpers';
import { warn } from '../utils/logUtils';
import { getNormalizeModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';

const VarRemoteEntry = (): Plugin[] => {
  const mfOptions = getNormalizeModuleFederationOptions();
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
            console.log({ filename });
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
      config(config, { command }) {
        if (!config.build) config.build = {};
      },
      /**
       * Generates the module federation "var" remote entry file
       * @param options - Rollup output options
       * @param bundle - Generated bundle assets
       */
      async generateBundle(options, bundle) {
        if (!varFilename) return;

        const isValidName = isValidVarName(name);

        if (!isValidName) {
          warn(
            `Provided remote name "${name}" is not valid for "var" remoteEntry type, thus it's placed in globalThis['${name}'].\nIt may cause problems, so you would better want to use valid var name (see https://www.w3schools.com/js/js_variables.asp).`
          );
        }

        const remoteEntryFile = findRemoteEntryFile(mfOptions.filename, bundle);

        if (!remoteEntryFile)
          throw new Error(
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
    const options = getNormalizeModuleFederationOptions();

    const { name, varFilename } = options;

    const isValidName = isValidVarName(name);

    // @TODO: implement publicPath/getPublicPath support
    return `
  ${isValidName ? `var ${name};` : ''}
  ${isValidName ? name : `globalThis['${name}']`} = (function () {
    function getScriptUrl() {
      const currentScript = document.currentScript;
      if (!currentScript) {
        console.error("[VarRemoteEntry] ${varFilename} script should be called from sync <script> tag (document.currentScript is undefined)")
        return '/';
      }
      return document.currentScript.src.replace(/\\/[^/]*$/, '/');
    }

    const entry = getScriptUrl() + '${remoteEntryFile}';

    return {
      get: (...args) => import(entry).then(m => m.get(...args)),
      init: (...args) => import(entry).then(m => m.init(...args)),
    };
  })();
  `;
  }
};

export default VarRemoteEntry;

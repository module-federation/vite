import * as fs from 'fs';
import * as path from 'pathe';
import { Plugin } from 'vite';
import { mapCodeToCodeWithSourcemap } from '../utils/mapCodeToCodeWithSourcemap';

import { inlineEntryScripts, sanitizeDevEntryPath } from '../utils/htmlEntryUtils';
import { mfWarn } from '../utils/logger';
import { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { hasPackageDependency } from '../utils/packageUtils';

interface AddEntryOptions {
  entryName: string;
  entryPath: string | (() => string);
  fileName?: string;
  inject?: NormalizedModuleFederationOptions['hostInitInjectLocation'];
}

function getFirstHtmlEntryFile(entryFiles: string[]): string | undefined {
  return entryFiles.find((file) => file.endsWith('.html'));
}

const addEntry = ({
  entryName,
  entryPath,
  fileName,
  inject = 'entry',
}: AddEntryOptions): Plugin[] => {
  const getEntryPath = () => (typeof entryPath === 'function' ? entryPath() : entryPath);
  let devEntryPath = '';
  let entryFiles: string[] = [];
  let htmlFilePath: string | undefined;
  let _command: string;
  let emitFileId: string;
  let viteConfig: any;
  let clientInjected = false;

  function injectHtml() {
    return inject === 'html' && htmlFilePath;
  }

  function injectEntry() {
    return inject === 'entry' || !htmlFilePath;
  }

  return [
    {
      name: 'add-entry',
      apply: 'serve',
      config(config, { command }) {
        _command = command;
      },
      configResolved(config) {
        viteConfig = config;
        const resolvedEntryPath = getEntryPath();
        devEntryPath = resolvedEntryPath.startsWith('virtual:mf')
          ? '@id/' + resolvedEntryPath
          : resolvedEntryPath;
        devEntryPath =
          config.base +
          devEntryPath
            .replace(/\\\\?/g, '/')
            .replace(/^[^:]+:([/\\])[/\\]?/, '$1')
            .replace(/^\//, '');
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (!fileName) {
            next();
            return;
          }
          if (req.url && req.url.startsWith((viteConfig.base + fileName).replace(/^\/?/, '/'))) {
            req.url = devEntryPath;
          }
          next();
        });
      },
      transformIndexHtml(c) {
        if (!injectHtml()) return;
        clientInjected = true;
        return inlineEntryScripts(c, devEntryPath);
      },
      transform(code, id) {
        if (id.includes('node_modules') || inject !== 'html' || htmlFilePath) {
          return;
        }

        if (id.includes('.svelte-kit') && id.includes('internal.js')) {
          return code.replace(
            /<head>/g,
            '<head><script type=\\"module\\" src=\\"' +
              sanitizeDevEntryPath(devEntryPath) +
              '\\"></script>'
          );
        }
      },
    },
    {
      name: 'add-entry',
      enforce: 'post',
      configResolved(config) {
        viteConfig = config;
        const inputOptions = config.build.rollupOptions.input;

        if (!inputOptions) {
          htmlFilePath = path.resolve(config.root, 'index.html');
        } else if (typeof inputOptions === 'string') {
          entryFiles = [inputOptions];
        } else if (Array.isArray(inputOptions)) {
          entryFiles = inputOptions;
        } else if (typeof inputOptions === 'object') {
          entryFiles = Object.values(inputOptions);
        }

        if (entryFiles && entryFiles.length > 0) {
          htmlFilePath = getFirstHtmlEntryFile(entryFiles);
        }

        if (_command === 'serve' && htmlFilePath && fs.existsSync(htmlFilePath)) {
          const htmlContent = fs.readFileSync(htmlFilePath, 'utf-8');
          const scriptRegex = /<script\s+[^>]*src=["']([^"']+)["'][^>]*>/gi;
          let match: RegExpExecArray | null;

          while ((match = scriptRegex.exec(htmlContent)) !== null) {
            entryFiles.push(match[1]);
          }
        }
      },
      buildStart() {
        if (_command === 'serve') return;
        const hasHash = fileName?.includes?.('[hash');
        const emitFileOptions: any = {
          name: entryName,
          type: 'chunk',
          id: getEntryPath(),
          preserveSignature: 'strict',
        };
        if (!hasHash) {
          emitFileOptions.fileName = fileName;
        }
        emitFileId = this.emitFile(emitFileOptions);
        if (htmlFilePath && fs.existsSync(htmlFilePath)) {
          const htmlContent = fs.readFileSync(htmlFilePath, 'utf-8');
          const scriptRegex = /<script\s+[^>]*src=["']([^"']+)["'][^>]*>/gi;
          let match: RegExpExecArray | null;

          while ((match = scriptRegex.exec(htmlContent)) !== null) {
            entryFiles.push(match[1]);
          }
        }
      },
      generateBundle(options, bundle) {
        if (!injectHtml()) return;
        const file = this.getFileName(emitFileId);
        // Helper to resolve path with proper renderBuiltUrl handling
        const resolvePath = (htmlFileName: string): string => {
          if (!viteConfig.experimental?.renderBuiltUrl) {
            return viteConfig.base + file;
          }

          const result = viteConfig.experimental.renderBuiltUrl(file, {
            hostId: htmlFileName,
            hostType: 'html',
            type: 'asset',
            ssr: false,
          });

          // Handle return types
          if (typeof result === 'string') {
            return result;
          }

          if (result && typeof result === 'object') {
            if ('runtime' in result) {
              // Runtime code cannot be used in <script src="">
              mfWarn(
                'renderBuiltUrl returned runtime code for HTML injection. ' +
                  'Runtime code cannot be used in <script src="">. Falling back to base path.'
              );
              return viteConfig.base + file;
            }
            if (result.relative) {
              return file;
            }
          }

          // Fallback for undefined or unexpected values
          return viteConfig.base + file;
        };

        // Process each HTML file
        for (const fileName in bundle) {
          if (fileName.endsWith('.html')) {
            let htmlAsset = bundle[fileName];
            if (htmlAsset.type === 'chunk') return;

            const path = resolvePath(fileName);
            const scriptContent = `
          <script type="module" src="${path}"></script>
        `;

            let htmlContent = htmlAsset.source.toString() || '';
            htmlContent = htmlContent.replace('<head>', `<head>${scriptContent}`);
            htmlAsset.source = htmlContent;
          }
        }
      },
      transform(code, id) {
        const isVinext = hasPackageDependency('vinext');
        if (
          isVinext &&
          inject === 'html' &&
          (id.includes('virtual:vite-rsc/entry-browser') ||
            id.includes('virtual:vinext-app-browser-entry'))
        ) {
          const injection = `import ${JSON.stringify(getEntryPath())};\n`;
          if (code.includes(injection.trim())) {
            clientInjected = true;
            return;
          }
          clientInjected = true;
          return mapCodeToCodeWithSourcemap(injection + code);
        }

        const shouldInject =
          (injectEntry() && entryFiles.some((file) => id.endsWith(file))) ||
          // Fallback for SSR frameworks (e.g. Nuxt) that bypass transformIndexHtml.
          (_command === 'serve' &&
            inject === 'html' &&
            !clientInjected &&
            !id.includes('node_modules') &&
            /\.(js|ts|mjs|vue|jsx|tsx)(\?|$)/.test(id));
        if (shouldInject) {
          clientInjected = true;
          const injection = `import ${JSON.stringify(getEntryPath())};\n`;
          return mapCodeToCodeWithSourcemap(injection + code);
        }
      },
    },
  ];
};

export default addEntry;

import * as fs from 'fs';
import * as path from 'pathe';
import { Plugin } from 'vite';

interface AddEntryOptions {
  entryName: string;
  entryPath: string;
  fileName?: string;
  inject?: 'entry' | 'html';
}

const addEntry = ({
  entryName,
  entryPath,
  fileName,
  inject = 'entry',
}: AddEntryOptions): Plugin[] => {
  let devEntryPath = entryPath.startsWith('virtual:mf') ? '@id/' + entryPath : entryPath;
  let entryFiles: string[] = [];
  let htmlFilePath: string;
  let _command: string;
  let emitFileId: string;
  let viteConfig: any;

  return [
    {
      name: 'add-entry',
      apply: 'serve',
      config(config, { command }) {
        _command = command;
      },
      configResolved(config) {
        viteConfig = config;
        devEntryPath =
          config.base +
          devEntryPath
            .replace(/\\\\?/g, '/')
            .replace(/.+?\:([/\\])[/\\]?/, '$1')
            .replace(/^\//, '');
      },
      configureServer(server) {
        server.httpServer?.once?.('listening', () => {
          const { port } = server.config.server;
          fetch(`http://localhost:${port}${devEntryPath}`).catch((e) => {});
        });
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
        if (inject !== 'html') return;
        return c.replace(
          '<head>',
          `<head><script type="module" src=${JSON.stringify(
            devEntryPath.replace(/.+?\:([/\\])[/\\]?/, '$1').replace(/\\\\?/g, '/')
          )}></script>`
        );
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
          htmlFilePath = path.resolve(config.root, inputOptions);
        } else if (Array.isArray(inputOptions)) {
          entryFiles = inputOptions;
          htmlFilePath = path.resolve(config.root, inputOptions[0]);
        } else if (typeof inputOptions === 'object') {
          entryFiles = Object.values(inputOptions);
          htmlFilePath = path.resolve(config.root, Object.values(inputOptions)[0]);
        }
      },
      buildStart() {
        if (_command === 'serve') return;
        const hasHash = fileName?.includes?.('[hash');
        const emitFileOptions: any = {
          name: entryName,
          type: 'chunk',
          id: entryPath,
          preserveSignature: 'strict',
        };
        if (!hasHash) {
          emitFileOptions.fileName = fileName;
        }
        emitFileId = this.emitFile(emitFileOptions);
        if (htmlFilePath) {
          const htmlContent = fs.readFileSync(htmlFilePath, 'utf-8');
          const scriptRegex = /<script\s+[^>]*src=["']([^"']+)["'][^>]*>/gi;
          let match: RegExpExecArray | null;

          while ((match = scriptRegex.exec(htmlContent)) !== null) {
            entryFiles.push(match[1]);
          }
        }
      },
      generateBundle(options, bundle) {
        if (inject !== 'html') return;
        const file = this.getFileName(emitFileId);
        const scriptContent = `
          <script type="module" src="${viteConfig.base + file}"></script>
        `;

        for (const fileName in bundle) {
          if (fileName.endsWith('.html')) {
            let htmlAsset = bundle[fileName];
            if (htmlAsset.type === 'chunk') return;
            let htmlContent = htmlAsset.source.toString() || '';

            htmlContent = htmlContent.replace('<head>', `<head>${scriptContent}`);

            htmlAsset.source = htmlContent;
          }
        }
      },
      transform(code, id) {
        if (inject === 'entry' && entryFiles.some((file) => id.endsWith(file))) {
          const injection = `
          import ${JSON.stringify(entryPath)};
          `;
          return injection + code;
        }
      },
    },
  ];
};

export default addEntry;

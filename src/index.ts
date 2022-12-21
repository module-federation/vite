import { BuildHelperParams, federationBuilder } from '@softarc/native-federation/build.js';
import * as fs from 'fs';
import * as path from 'path';

import mime from 'mime-types';
import { Connect, ViteDevServer } from 'vite';
import { devExternalsMixin } from './dev-externals-mixin';
import { filterExternals } from './externals-skip-list';

export const federation = async (params: BuildHelperParams) => {
  return {
    name: '@module-federation/vite', // required, will show up in warnings and errors
    async options(o: unknown) {
      await federationBuilder.init(params);
      o!['external'] = filterExternals(federationBuilder.externals);
    },
    async closeBundle() {
      await federationBuilder.build();
    },
    async configureServer(server: ViteDevServer) {
      await configureDevServer(server, params);
    },
    transformIndexHtml(html: string) {
      return html.replace(/type="module"/g, 'type="module-shim"');
    },
    ...devExternalsMixin,
  };
};

const configureDevServer = async (server: ViteDevServer, params: BuildHelperParams) => {
  await federationBuilder.build({
    skipExposed: true,
    skipMappings: true,
  });

  const op = params.options;
  const dist = path.join(op.workspaceRoot, op.outputPath);
  server.middlewares.use(serveFromDist(dist));
};

const serveFromDist = (dist: string): Connect.NextHandleFunction => {
  return (req, res, next) => {
    if (!req.url || req.url.endsWith('/index.html')) {
      next();
      return;
    }

    const file = path.join(dist, req.url);
    if (fs.existsSync(file) && fs.lstatSync(file).isFile()) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', mime.lookup(req.url));

      const content = fs.readFileSync(file, 'utf-8');
      const modified = enhanceFile(file, content);

      res.write(modified);
      res.end();
      return;
    }

    next();
  };
};

const enhanceFile = (fileName: string, src: string): string => {
  if (fileName.endsWith('remoteEntry.json')) {
    let remoteEntry = JSON.parse(fs.readFileSync(fileName, 'utf-8'));
    remoteEntry = {
      ...remoteEntry,
      shared: (remoteEntry.shared || []).map((el) => ({
        ...el,
        outFileName: el.dev?.entryPoint.includes('/node_modules/')
          ? el.outFileName
          : normalize(path.join('@fs', el.dev?.entryPoint || '')),
      })),
      exposes: (remoteEntry.exposes || []).map((el) => ({
        ...el,
        outFileName: normalize(path.join('@fs', el.dev?.entryPoint || '')),
      })),
    };
    return JSON.stringify(remoteEntry, null, 2);
  }
  return src;
};

const normalize = (path: string): string => {
  return path.replace(/\\/g, '/');
};

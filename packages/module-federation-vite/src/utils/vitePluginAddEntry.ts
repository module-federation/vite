
import { Plugin } from 'vite';

interface AddEntryOptions {
  entryName: string;
  entryPath: string;
  fileName: string;
}

const addEntry = ({ entryName, entryPath, fileName }: AddEntryOptions): Plugin => {
  let command: string;

  return {
    name: 'add-entry',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.startsWith(fileName.replace(/^\/?/, "/"))) {
          req.url = entryPath;
        }
        next();
      });
    },
    config(config, { command: _command }) {
      command = _command;
    },
    buildStart() {
      if (command !== "build") return;
      // if we don't expose any modules, there is no need to emit file
      this.emitFile({
        fileName: `${fileName}`,
        type: 'chunk',
        id: entryPath,
        preserveSignature: 'strict'
      });
    },
    transformIndexHtml(c) {
      if (command !== "build") return c.replace("<head>", `<head><script type="module" src=${JSON.stringify(entryPath.replace(/.+?\:([/\\])[/\\]?/, "$1").replace(/\\/g, "/"))}></script>`);
      return c.replace("<head>", `<head><script type="module" src=${fileName}></script>`);
    },
  };
};

export default addEntry;

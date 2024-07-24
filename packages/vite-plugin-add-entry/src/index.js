
module.exports = function addEntry(entryName, entryPath, fileName) {
  let command
  return {
    name: 'add-entry',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url.startsWith(fileName.replace(/^\/?/, "/"))) {
          req.url = entryPath
        }
        next();
      });
    },
    config(config, {command: _command}) {
      command = _command
    },
    buildStart() {
      if (command !== "build") return
      // if we don't expose any modules, there is no need to emit file
      this.emitFile({
        fileName: `${fileName}`,
        type: 'chunk',
        id: entryPath,
        preserveSignature: 'strict'
      })
    },
    transformIndexHtml(c) {
      if (command !== "build") return c.replace("<head>", `<head><script type="module" src=${JSON.stringify(entryPath)}></script>`)
        return c.replace("<head>", `<head><script type="module" src=${fileName}></script>`)

    },
  };
};

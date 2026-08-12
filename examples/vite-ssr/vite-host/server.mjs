import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const template = fs.readFileSync(path.resolve(root, 'dist/client/index.html'), 'utf-8');

// The federation plugin adds its own entries to the SSR build, so the app
// entry is emitted under assets/ with a content hash.
const serverAssetsDir = path.resolve(root, 'dist/server/assets');
const entryFileNames = fs
  .readdirSync(serverAssetsDir)
  .filter((file) => file.startsWith('entry-server-') && file.endsWith('.js'));
if (entryFileNames.length !== 1) {
  // More than one match means a stale or interrupted build left old hashed
  // copies behind; loading an arbitrary one would render outdated code.
  throw new Error(
    `Expected exactly one entry-server-*.js in ${serverAssetsDir}, ` +
      `found ${entryFileNames.length}: [${entryFileNames.join(', ')}]`
  );
}
const [entryFileName] = entryFileNames;
const { render } = await import(
  new URL(`./dist/server/assets/${entryFileName}`, import.meta.url).href
);

const CONTENT_TYPES = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url ?? '/').split('?')[0];

  // Playwright's webServer readiness probe. Deliberately independent of the
  // remote: if the readiness URL required a successful render, a missing
  // remote SSR entry would surface as a 120s webServer timeout instead of
  // the spec's own assertion failures.
  if (urlPath === '/healthz') {
    res.setHeader('Content-Type', 'text/plain');
    res.end('ok');
    return;
  }

  if (urlPath !== '/') {
    const clientDir = path.resolve(root, 'dist/client');
    const filePath = path.resolve(clientDir, `.${urlPath}`);
    // Compare with a trailing separator so `../` can't escape to sibling
    // directories that merely share the prefix (e.g. dist/client-extra).
    if (filePath.startsWith(clientDir + path.sep) && isFile(filePath)) {
      res.setHeader(
        'Content-Type',
        CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream'
      );
      const stream = fs.createReadStream(filePath);
      // A read failure (file replaced mid-stream, EISDIR, ...) must end the
      // response, not crash the process.
      stream.on('error', (error) => {
        console.error('[ssr-host] static read failed:', error);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'text/plain');
        }
        res.end('Internal server error');
      });
      stream.pipe(res);
      return;
    }
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Not found');
    return;
  }

  try {
    const appHtml = await render();
    res.setHeader('Content-Type', 'text/html');
    // Function replacement so `$`-sequences in the rendered HTML are not
    // interpreted as replacement patterns.
    res.end(template.replace('<!--ssr-outlet-->', () => appHtml));
  } catch (error) {
    // Keep the process alive: Playwright's webServer readiness check polls
    // this URL and the remote may still be booting on the first requests.
    console.error('[ssr-host] render failed:', error);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain');
    res.end('SSR render failed');
  }
});

server.listen(5178, () => {
  console.log('SSR host listening on http://localhost:5178');
});

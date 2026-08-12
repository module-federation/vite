import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const template = fs.readFileSync(path.resolve(root, 'dist/client/index.html'), 'utf-8');

// The federation plugin adds its own entries to the SSR build, so the app
// entry is emitted under assets/ with a content hash.
const serverAssetsDir = path.resolve(root, 'dist/server/assets');
const entryFileName = fs
  .readdirSync(serverAssetsDir)
  .find((file) => file.startsWith('entry-server-') && file.endsWith('.js'));
if (!entryFileName) {
  throw new Error(`No entry-server-*.js found in ${serverAssetsDir}`);
}
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

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url ?? '/').split('?')[0];

  if (urlPath !== '/') {
    const filePath = path.resolve(root, 'dist/client', `.${urlPath}`);
    if (filePath.startsWith(path.resolve(root, 'dist/client')) && fs.existsSync(filePath)) {
      res.setHeader(
        'Content-Type',
        CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream'
      );
      fs.createReadStream(filePath).pipe(res);
      return;
    }
    res.statusCode = 404;
    res.end('Not found');
    return;
  }

  try {
    const appHtml = await render();
    res.setHeader('Content-Type', 'text/html');
    res.end(template.replace('<!--ssr-outlet-->', appHtml));
  } catch (error) {
    // Keep the process alive: Playwright's webServer readiness check polls
    // this URL and the remote may still be booting on the first requests.
    console.error('[ssr-host] render failed:', error);
    res.statusCode = 500;
    res.end('SSR render failed');
  }
});

server.listen(5178, () => {
  console.log('SSR host listening on http://localhost:5178');
});

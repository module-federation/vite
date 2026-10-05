import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, type Rollup } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { federation } from '../src';
import { getPackageDetectionCwd, setPackageDetectionCwd } from '../src/utils/packageUtils';
import { isRollupChunk } from './helpers/assertions';
import { getAllChunkCode } from './helpers/matchers';

const outputDirs: string[] = [];

afterEach(async () => {
  await Promise.all(outputDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createExposingRemote() {
  // Keep the fixture inside the repo, like ssr-shared-exports.test.ts. Vitest's
  // module runner rewrites out-of-root relative chunk imports to /@fs/ paths
  // that Node cannot load — the Vite 5 SSR graph still splits hostInit/helpers.
  const root = await mkdtemp(resolve(import.meta.dirname, '.mf-ssr-deferred-entry-'));
  outputDirs.push(root);
  const sharedPkg = resolve(root, 'node_modules/mock-ui-lib');
  await mkdir(sharedPkg, { recursive: true });
  await writeFile(
    resolve(root, 'package.json'),
    JSON.stringify({ name: 'ssr-deferred-entry-remote', type: 'module' })
  );
  await writeFile(
    resolve(sharedPkg, 'package.json'),
    JSON.stringify({
      name: 'mock-ui-lib',
      version: '1.0.0',
      type: 'module',
      exports: './index.js',
    })
  );
  await writeFile(
    resolve(sharedPkg, 'index.js'),
    `export function defineComponent(options) {
      return {
        name: options.name,
        render: options.setup(),
      };
    }
    export function h(tag, props, children) {
      const id = props?.id ? \` id="\${props.id}"\` : '';
      return \`<\${tag}\${id}>\${children}</\${tag}>\`;
    }
`
  );
  await mkdir(resolve(root, 'src'), { recursive: true });
  await writeFile(
    resolve(root, 'src/App.js'),
    `import { defineComponent, h } from 'mock-ui-lib';
export default defineComponent({
  name: 'App',
  setup() {
    return () => h('h1', { id: 'ssr-ok' }, 'SSR deferred entry singleton');
  },
});
`
  );
  await writeFile(
    resolve(root, 'src/entry-server.js'),
    `import App from './App.js';
export function render() {
  return \`<!doctype html><div id="app">\${App.render()}</div>\`;
}
`
  );
  await writeFile(
    resolve(root, 'src/entry-client.js'),
    `import App from './App.js';
document.querySelector('#app').innerHTML = App.render();
`
  );
  await writeFile(
    resolve(root, 'index.html'),
    '<!doctype html><div id="app"></div><script type="module" src="/src/entry-client.js"></script>'
  );
  return root;
}

function federationOptions(root: string) {
  return {
    name: 'ssrRemote',
    filename: 'remoteEntry.js',
    // Absolute: Rollup (Vite 5-7) cannot resolve a relative specifier from the
    // virtual exposes module when the root is not process.cwd().
    exposes: { './App': resolve(root, 'src/App.js') },
    shared: { 'mock-ui-lib': { singleton: true } },
    shareStrategy: 'version-first' as const,
    hostInitInjectLocation: 'entry' as const,
    dts: false,
  };
}

describe('SSR deferred entry-injected singleton fallback', () => {
  it('renders module-scope shared exports during production SSR', async () => {
    const previousCwd = getPackageDetectionCwd();
    const root = await createExposingRemote();
    const outDir = resolve(root, 'dist/ssr');
    try {
      const result = await build({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [federation(federationOptions(root))],
        ssr: { noExternal: true },
        build: {
          ssr: true,
          outDir,
          write: true,
          minify: false,
          target: 'node20',
          rollupOptions: {
            input: resolve(root, 'src/entry-server.js'),
          },
        },
      });
      expect(Array.isArray(result), 'Expected a single RollupOutput, not an array').toBe(false);
      const output = result as Rollup.RollupOutput;
      const bundleCode = getAllChunkCode(output);
      expect(bundleCode).toMatch(/\b(?:let|var) __mf_0\b/);
      expect(bundleCode).toContain('__mfNormalizeShareModule');
      expect(bundleCode).toContain('__mfApplyLazyShareExports');

      // Vite 5 (no Environment API) still injects the client hostInit bootstrap
      // into the SSR input, which replaces the file with a wrapper that does not
      // re-export render(). The original module is emitted as ?mf-entry-bootstrap.
      const entryChunk = output.output
        .filter(isRollupChunk)
        .find(
          (chunk) =>
            chunk.exports.includes('render') &&
            typeof chunk.facadeModuleId === 'string' &&
            chunk.facadeModuleId.includes('entry-server.js')
        );
      expect(entryChunk, 'Expected the SSR entry chunk that exports render()').toBeDefined();

      const serverEntry = await import(
        `${pathToFileURL(resolve(outDir, entryChunk!.fileName)).href}?test=${Date.now()}`
      );
      expect(serverEntry.render).toBeTypeOf('function');
      const html = serverEntry.render();
      expect(html).toContain('id="ssr-ok"');
      expect(html).toContain('SSR deferred entry singleton');
    } finally {
      setPackageDetectionCwd(previousCwd);
    }
  });

  it('keeps the client loadShare wrapper deferred without a static local import', async () => {
    const previousCwd = getPackageDetectionCwd();
    const root = await createExposingRemote();
    const outDir = resolve(root, 'dist/client');
    try {
      const result = await build({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [federation(federationOptions(root))],
        build: {
          outDir,
          write: true,
          minify: false,
          target: 'esnext',
        },
      });
      expect(Array.isArray(result), 'Expected a single RollupOutput, not an array').toBe(false);
      const output = result as Rollup.RollupOutput;
      const bundleCode = getAllChunkCode(output);
      expect(bundleCode).toContain('Promise.race');
      expect(bundleCode).not.toMatch(/import\s+\*\s+as\s+__mfLocalShare\s+from/);
    } finally {
      setPackageDetectionCwd(previousCwd);
    }
  });
});

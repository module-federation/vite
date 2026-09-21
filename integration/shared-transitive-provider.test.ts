import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { federation } from '../src/index';
import { getPackageDetectionCwd, setPackageDetectionCwd } from '../src/utils/packageUtils';
import { buildFixture } from './helpers/build';
import { getAllChunkCode, parseManifest } from './helpers/matchers';

describe('shared transitive provider', () => {
  let root: string;
  let previousCwd: string;

  function write(relativePath: string, content: string) {
    const file = path.join(root, relativePath);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  function link(relativePath: string, target: string) {
    const file = path.join(root, relativePath);
    mkdirSync(path.dirname(file), { recursive: true });
    symlinkSync(target, file, 'dir');
  }

  function installPnpmPackage(name: string, version: string, content: Record<string, unknown>) {
    const dir = `node_modules/.pnpm/${name}@${version}/node_modules/${name}`;
    write(
      `${dir}/package.json`,
      JSON.stringify({ name, version, type: 'module', main: './index.js', ...content })
    );
    return dir;
  }

  // pnpm's default layout: a transitive dependency is only linked into its
  // parent's node_modules, so nothing above the app root can resolve it.
  beforeEach(() => {
    previousCwd = getPackageDetectionCwd();
    root = mkdtempSync(path.resolve('node_modules/.shared-transitive-'));
    write(
      'package.json',
      JSON.stringify({
        name: 'transitive-app',
        type: 'module',
        dependencies: { 'mf-parent-lib': '1.0.0' },
      })
    );
    write('index.html', '<script type="module" src="/main.js"></script>');

    const parentDir = installPnpmPackage('mf-parent-lib', '1.0.0', {
      dependencies: { 'mf-nested-lib': '2.1.0' },
    });
    write(
      `${parentDir}/index.js`,
      `import { nested } from 'mf-nested-lib';
       export const parent = 'parent:' + nested;`
    );
    const nestedDir = installPnpmPackage('mf-nested-lib', '2.1.0', {
      exports: { '.': { browser: './index.js', default: './index.js' } },
    });
    write(`${nestedDir}/index.js`, "export const nested = 'nested-marker';");

    link('node_modules/mf-parent-lib', `.pnpm/mf-parent-lib@1.0.0/node_modules/mf-parent-lib`);
    link(
      `node_modules/.pnpm/mf-parent-lib@1.0.0/node_modules/mf-nested-lib`,
      `../../mf-nested-lib@2.1.0/node_modules/mf-nested-lib`
    );
    setPackageDetectionCwd(root);
  });

  afterEach(() => {
    setPackageDetectionCwd(previousCwd);
    rmSync(root, { recursive: true, force: true });
  });

  async function buildApp(mfOptions: Record<string, unknown>) {
    write('main.js', "import { parent } from 'mf-parent-lib';\nconsole.log(parent);");
    return buildFixture({
      mfOptions: {
        name: 'transitiveApp',
        shared: { 'mf-nested-lib': { singleton: true } },
        manifest: true,
        ...mfOptions,
      },
      viteConfig: { root, configFile: false },
    });
  }

  // A container materializes its shared fallbacks before any app module is
  // resolved, so the two shapes exercise different resolution orders.
  it.each([
    ['a host', {}],
    ['a remote container', { exposes: { './Parent': './main.js' } }],
  ])('shares a package only installed under its parent from %s', async (_shape, mfOptions) => {
    const output = await buildApp(mfOptions);

    expect(parseManifest(output)).toMatchObject({
      shared: [expect.objectContaining({ name: 'mf-nested-lib', version: '2.1.0' })],
    });
    expect(getAllChunkCode(output)).toContain('nested-marker');
  });

  // Two versions in the store is the normal state of a pnpm workspace. The
  // fallback must be the one the parent links, not whichever the store lists first.
  it.each([
    ['2.1.0', '3.0.0'],
    ['3.0.0', '2.1.0'],
    ['9.0.0', '10.0.0'],
  ])('picks the linked %s over the unrelated %s in the store', async (linked, stale) => {
    installPnpmPackage('mf-nested-lib', stale, {});
    write(
      `node_modules/.pnpm/mf-nested-lib@${stale}/node_modules/mf-nested-lib/index.js`,
      `export const nested = 'stale-${stale}';`
    );
    installPnpmPackage('mf-nested-lib', linked, {});
    write(
      `node_modules/.pnpm/mf-nested-lib@${linked}/node_modules/mf-nested-lib/index.js`,
      `export const nested = 'linked-${linked}';`
    );
    rmSync(path.join(root, 'node_modules/.pnpm/mf-parent-lib@1.0.0/node_modules/mf-nested-lib'));
    link(
      `node_modules/.pnpm/mf-parent-lib@1.0.0/node_modules/mf-nested-lib`,
      `../../mf-nested-lib@${linked}/node_modules/mf-nested-lib`
    );

    const output = await buildApp({});

    expect(getAllChunkCode(output)).toContain(`linked-${linked}`);
    expect(getAllChunkCode(output)).not.toContain(`stale-${stale}`);
    expect(parseManifest(output)).toMatchObject({
      shared: [expect.objectContaining({ name: 'mf-nested-lib', version: linked })],
    });
  });

  it('serves the nested provider in dev', async () => {
    write('main.js', "import { parent } from 'mf-parent-lib';\nconsole.log(parent);");
    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      server: { middlewareMode: true, hmr: false },
      plugins: [
        federation({
          name: 'transitiveApp',
          exposes: {},
          shared: { 'mf-nested-lib': {} },
          dts: false,
        }),
      ],
    });

    try {
      const seen = new Set<string>();
      const pending = ['/main.js'];
      while (pending.length) {
        const url = pending.shift()!;
        if (seen.has(url) || seen.size > 40) continue;
        seen.add(url);
        const result = await server.transformRequest(url);
        if (!result) continue;
        for (const [, spec] of result.code.matchAll(/from\s*"([^"]+)"/g)) pending.push(spec);
      }

      // The share's fallback imports the store file directly. Without it the
      // nested package is inlined into the optimizer's pre-bundle instead.
      const files = [...server.moduleGraph.idToModuleMap.values()].map((mod) => mod.file);
      expect(files).toContain(
        path.join(
          root,
          'node_modules/.pnpm/mf-nested-lib@2.1.0/node_modules/mf-nested-lib/index.js'
        )
      );
    } finally {
      await server.close();
    }
  });
});

import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { federation } from '../src/index';
import { withNodePath } from '../src/utils/__tests__/helpers';
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
        // mf-other-lib is visited first and declares nothing, so it exercises
        // the declared-edge rule in the dependency walk.
        dependencies: { 'mf-other-lib': '1.0.0', 'mf-parent-lib': '1.0.0' },
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

    installPnpmPackage('mf-other-lib', '1.0.0', {});
    write(
      `node_modules/.pnpm/mf-other-lib@1.0.0/node_modules/mf-other-lib/index.js`,
      'export const other = 1;'
    );
    link('node_modules/mf-other-lib', `.pnpm/mf-other-lib@1.0.0/node_modules/mf-other-lib`);
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

  async function buildApp(mfOptions: Record<string, unknown>, entryPackage = 'mf-parent-lib') {
    write('main.js', `import * as entry from '${entryPackage}';\nconsole.log(entry);`);
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
    ['a host', false],
    ['a remote container', true],
  ])('shares a package only installed under its parent from %s', async (_shape, exposed) => {
    // Vite 5-7 only: Rollup resolves an expose from the virtual remote-entry id,
    // which has no directory to resolve "./main.js" against, and fails with
    // "Could not resolve". Rolldown handles the relative form; an absolute path
    // works on both.
    const output = await buildApp(
      exposed ? { exposes: { './Parent': path.join(root, 'main.js') } } : {}
    );

    expect(parseManifest(output)).toMatchObject({
      shared: [expect.objectContaining({ name: 'mf-nested-lib', version: '2.1.0' })],
    });
    expect(getAllChunkCode(output)).toContain('nested-marker');
  });

  it('follows a parent listed under the root devDependencies', async () => {
    write(
      'package.json',
      JSON.stringify({
        name: 'transitive-app',
        type: 'module',
        devDependencies: { 'mf-parent-lib': '1.0.0' },
      })
    );
    // A stale copy that a store scan would list first.
    installPnpmPackage('mf-nested-lib', '1.0.0', {});
    write(
      'node_modules/.pnpm/mf-nested-lib@1.0.0/node_modules/mf-nested-lib/index.js',
      "export const nested = 'stale-1.0.0';"
    );
    link('node_modules/.pnpm/node_modules/mf-nested-lib', '../mf-nested-lib@1.0.0/node_modules/mf-nested-lib');

    const output = await buildApp({});

    expect(getAllChunkCode(output)).toContain('nested-marker');
    expect(getAllChunkCode(output)).not.toContain('stale-1.0.0');
    expect(parseManifest(output)).toMatchObject({
      shared: [expect.objectContaining({ name: 'mf-nested-lib', version: '2.1.0' })],
    });
  });

  // pnpm's bin shims export NODE_PATH with the store's hoisted node_modules, so
  // `pnpm build` runs Vite with a lookup path that Node searches and Vite does not.
  it('ignores the hoisted store that pnpm puts on NODE_PATH', async () => {
    installPnpmPackage('mf-nested-lib', '1.0.0', {});
    write(
      'node_modules/.pnpm/mf-nested-lib@1.0.0/node_modules/mf-nested-lib/index.js',
      "export const nested = 'hoisted-1.0.0';"
    );
    link(
      'node_modules/.pnpm/node_modules/mf-nested-lib',
      '../mf-nested-lib@1.0.0/node_modules/mf-nested-lib'
    );

    const output = await withNodePath(path.join(root, 'node_modules/.pnpm/node_modules'), () =>
      buildApp({})
    );

    expect(getAllChunkCode(output)).toContain('nested-marker');
    expect(getAllChunkCode(output)).not.toContain('hoisted-1.0.0');
    expect(parseManifest(output)).toMatchObject({
      shared: [expect.objectContaining({ name: 'mf-nested-lib', version: '2.1.0' })],
    });
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
    // pnpm's hidden hoist dir. Node resolution from a package that does not
    // declare mf-nested-lib walks up into it and finds the stale copy.
    link(
      `node_modules/.pnpm/node_modules/mf-nested-lib`,
      `../mf-nested-lib@${stale}/node_modules/mf-nested-lib`
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

  // The same package name at two versions on two branches, where only the
  // second declares the target. A walk keyed by name visits mf-util-lib once,
  // via the first branch, and never sees the edge on the second.
  it('walks every installed version of an intermediate package', async () => {
    write(
      'package.json',
      JSON.stringify({
        name: 'transitive-app',
        type: 'module',
        dependencies: { 'mf-first-lib': '1.0.0', 'mf-second-lib': '1.0.0' },
      })
    );
    for (const [lib, utilVersion] of [
      ['mf-first-lib', '1.0.0'],
      ['mf-second-lib', '2.0.0'],
    ]) {
      const dir = installPnpmPackage(lib, '1.0.0', { dependencies: { 'mf-util-lib': utilVersion } });
      write(`${dir}/index.js`, `export * from 'mf-util-lib';`);
      link(`node_modules/${lib}`, `.pnpm/${lib}@1.0.0/node_modules/${lib}`);
      link(
        `node_modules/.pnpm/${lib}@1.0.0/node_modules/mf-util-lib`,
        `../../mf-util-lib@${utilVersion}/node_modules/mf-util-lib`
      );
    }
    const firstUtil = installPnpmPackage('mf-util-lib', '1.0.0', {});
    write(`${firstUtil}/index.js`, 'export const util = 1;');
    const secondUtil = installPnpmPackage('mf-util-lib', '2.0.0', {
      dependencies: { 'mf-nested-lib': '3.0.0' },
    });
    write(`${secondUtil}/index.js`, "export { nested } from 'mf-nested-lib';");
    const linkedNested = installPnpmPackage('mf-nested-lib', '3.0.0', {});
    write(`${linkedNested}/index.js`, "export const nested = 'linked-3.0.0';");
    link(
      `node_modules/.pnpm/mf-util-lib@2.0.0/node_modules/mf-nested-lib`,
      `../../mf-nested-lib@3.0.0/node_modules/mf-nested-lib`
    );

    const output = await buildApp({}, 'mf-second-lib');

    expect(getAllChunkCode(output)).toContain('linked-3.0.0');
    expect(parseManifest(output)).toMatchObject({
      shared: [expect.objectContaining({ name: 'mf-nested-lib', version: '3.0.0' })],
    });
  });

  // Vite 5 only: transformRequest on a node_modules dependency leaves a pending
  // request the esbuild optimizer never settles, so server.close() hangs forever
  // and the test times out rather than failing. Discovery off keeps the crawl
  // clear of the optimizer. Remove when Vite 5 leaves the support matrix.
  const VITE_5_OPTIMIZER_CLOSE_DEADLOCK = { noDiscovery: true, include: [] };

  it('serves the nested provider in dev', { timeout: 20_000 }, async () => {
    write('main.js', "import { parent } from 'mf-parent-lib';\nconsole.log(parent);");
    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      server: { middlewareMode: true, hmr: false },
      optimizeDeps: VITE_5_OPTIMIZER_CLOSE_DEADLOCK,
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
      // The loadShare wrapper is the share's fallback. Its code naming the store
      // copy is what proves the provider resolved, and it exists only when the
      // package is actually shared.
      const seen = new Set<string>();
      const pending = ['/main.js'];
      let fallbackCode: string | undefined;
      while (pending.length && fallbackCode === undefined) {
        const url = pending.shift()!;
        if (seen.has(url)) continue;
        seen.add(url);
        const result = await server.transformRequest(url);
        if (!result) continue;
        if (url.includes('__loadShare__')) fallbackCode = result.code;
        for (const [, spec] of result.code.matchAll(/from\s*"([^"]+)"/g)) pending.push(spec);
      }

      expect(fallbackCode).toContain(
        'node_modules/.pnpm/mf-nested-lib@2.1.0/node_modules/mf-nested-lib'
      );
    } finally {
      await server.close();
    }
  });
});

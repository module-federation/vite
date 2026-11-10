import fs, {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPackageDetectionCwd, setPackageDetectionCwd } from '../src/utils/packageUtils';
import { buildFixture } from './helpers/build';

// A remote in a pnpm `hoist: false` workspace whose shared singleton depends on
// a large tooling tree (#1565). The plugin's filesystem work must stay bounded:
// every regression found there was a walk repeated per name, per directory or
// per share key, which multiplies these counts rather than adding to them.
const WIDTH = 3;
const DEPTH = 6;
const SUBPATHS = 10;
const PLUGIN_SOURCE = `${path.resolve(__dirname, '../src')}${path.sep}`;
// About twice today's counts (793, 187, 24, 48, 18): room for ordinary changes,
// while each regression found so far multiplied them (4844, 1205, 596 before #1565).
const FS_CALL_BUDGET = {
  existsSync: 1600,
  readFileSync: 400,
  readdirSync: 50,
  realpathSync: 100,
  statSync: 40,
  lstatSync: 20,
};
const COUNTED_FS_CALLS = Object.keys(FS_CALL_BUDGET) as (keyof typeof FS_CALL_BUDGET)[];

describe('pnpm isolated install with a shared tooling package', () => {
  let root: string;
  let previousCwd: string;

  function write(relativePath: string, content: string) {
    const file = path.join(root, relativePath);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  function link(from: string, toStoreDir: string) {
    const file = path.join(root, from);
    mkdirSync(path.dirname(file), { recursive: true });
    symlinkSync(path.relative(path.dirname(file), path.join(root, toStoreDir)), file, 'dir');
  }

  const storeDir = (name: string, version: string) =>
    `node_modules/.pnpm/${name}@${version}/node_modules/${name}`;

  // Installs a package the pnpm way: its dependencies are linked next to it, so
  // only its own directory can resolve them.
  function install(
    name: string,
    version: string,
    dependencies: Record<string, string> = {},
    extra: Record<string, unknown> = {}
  ) {
    const dir = storeDir(name, version);
    write(
      `${dir}/package.json`,
      JSON.stringify({ name, version, type: 'module', main: './index.js', dependencies, ...extra })
    );
    write(`${dir}/index.js`, `export default ${JSON.stringify(name)};`);
    for (const [dependency, dependencyVersion] of Object.entries(dependencies)) {
      link(
        `node_modules/.pnpm/${name}@${version}/node_modules/${dependency}`,
        storeDir(dependency, dependencyVersion)
      );
    }
    return dir;
  }

  beforeEach(() => {
    previousCwd = getPackageDetectionCwd();
    root = mkdtempSync(path.resolve('node_modules/.pnpm-isolated-tooling-'));

    // Two dev tools install different versions of one package, so a search of
    // the whole graph by name finds conflicting copies and warns.
    install('conflict', '1.0.0');
    install('conflict', '2.0.0');
    install('dev-a', '1.0.0', { conflict: '1.0.0' });
    install('dev-b', '1.0.0', { conflict: '2.0.0' });

    // Every package of a layer depends on every package of the next one, and
    // each declares an optional dependency that is not installed. For the last
    // layer that is `conflict`: only a search of the whole graph would find it.
    const layer = (i: number) => Array.from({ length: WIDTH }, (_, j) => `tool-${i}-${j}`);
    for (let i = DEPTH - 1; i >= 0; i--) {
      const next = i + 1 < DEPTH ? layer(i + 1) : [];
      for (const name of layer(i)) {
        install(
          name,
          '1.0.0',
          Object.fromEntries(next.map((dependency) => [dependency, '1.0.0'])),
          {
            optionalDependencies: { [i + 1 < DEPTH ? `${name}-binary` : 'conflict']: '1.0.0' },
          }
        );
      }
    }

    const uiExports: Record<string, string> = { '.': './index.js' };
    for (let i = 0; i < SUBPATHS; i++) uiExports[`./s${i}`] = `./s${i}.js`;
    const uiDir = install('ui-lib', '1.0.0', {}, { exports: uiExports });
    for (let i = 0; i < SUBPATHS; i++) write(`${uiDir}/s${i}.js`, `export const s${i} = ${i};`);

    // The workspace package holding the federation tooling and a singleton runtime.
    write(
      'packages/tooling/package.json',
      JSON.stringify({
        name: 'tooling',
        version: '1.0.0',
        type: 'module',
        exports: { './runtime': './runtime.js' },
        dependencies: Object.fromEntries(layer(0).map((name) => [name, '1.0.0'])),
        optionalDependencies: { 'tooling-binary': '1.0.0' },
        peerDependencies: { '@module-federation/runtime': '*' },
      })
    );
    write('packages/tooling/runtime.js', 'export const runtime = { id: 1 };');
    for (const name of layer(0)) {
      link(`packages/tooling/node_modules/${name}`, storeDir(name, '1.0.0'));
    }

    write(
      'package.json',
      JSON.stringify({
        name: 'isolated-remote',
        type: 'module',
        dependencies: { 'ui-lib': '1.0.0', tooling: 'workspace:*' },
        devDependencies: { 'dev-a': '1.0.0', 'dev-b': '1.0.0' },
      })
    );
    link('node_modules/ui-lib', storeDir('ui-lib', '1.0.0'));
    link('node_modules/dev-a', storeDir('dev-a', '1.0.0'));
    link('node_modules/dev-b', storeDir('dev-b', '1.0.0'));
    link('node_modules/tooling', 'packages/tooling');

    write(
      'widget.js',
      `import ui from 'ui-lib';
       import { s0 } from 'ui-lib/s0';
       import { runtime } from 'tooling/runtime';
       export default [ui, s0, runtime];`
    );
    write('index.html', '<script type="module" src="/widget.js"></script>');
    setPackageDetectionCwd(root);
  });

  afterEach(() => {
    setPackageDetectionCwd(previousCwd);
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps the plugin filesystem work bounded and warns about nothing unshared', async () => {
    const counts = Object.fromEntries(COUNTED_FS_CALLS.map((name) => [name, 0])) as Record<
      keyof typeof FS_CALL_BUDGET,
      number
    >;
    const realRoot = realpathSync(root);
    const spies = COUNTED_FS_CALLS.map((name) => {
      const original = fs[name] as (...args: unknown[]) => unknown;
      return vi.spyOn(fs, name as never).mockImplementation(((...args: unknown[]) => {
        // Only the fixture's paths: Vite's own reads and the repository's
        // node_modules would make the counts move with unrelated changes.
        const file = String(args[0]);
        if (
          (file.startsWith(root) || file.startsWith(realRoot)) &&
          new Error().stack?.includes(PLUGIN_SOURCE)
        ) {
          counts[name]++;
        }
        return original(...args);
      }) as never);
    });
    syncBuiltinESMExports();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let warnings: string[] = [];
    try {
      await buildFixture({
        mfOptions: {
          name: 'isolatedRemote',
          exposes: { './Widget': path.join(root, 'widget.js') },
          shared: {
            'ui-lib': { singleton: true },
            'ui-lib/': { singleton: true },
            'tooling/runtime': { singleton: true },
          },
        },
        viteConfig: { root, configFile: false },
      });
      warnings = warn.mock.calls.map(([message]) => String(message));
    } finally {
      for (const spy of spies) spy.mockRestore();
      syncBuiltinESMExports();
      warn.mockRestore();
    }
    expect(warnings.filter((message) => message.includes('is not a dependency'))).toEqual([]);
    for (const name of COUNTED_FS_CALLS) {
      expect(counts[name], `${name} calls on the fixture`).toBeLessThanOrEqual(
        FS_CALL_BUDGET[name]
      );
    }
  });
});

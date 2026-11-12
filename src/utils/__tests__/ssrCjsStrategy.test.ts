import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateSsrCommonJs } from '../ssrCjsStrategy';

describe('owned CommonJS SSR evaluation', () => {
  it('evaluates in the host realm without creating a Node cache entry', async () => {
    const before = Object.keys(createRequire(import.meta.url).cache);
    const result = await evaluateSsrCommonJs(
      'module.exports = { init() {}, get() { return () => ({ default: [Array, Object, globalThis] }); } };',
      'http://remote.test/remoteEntry.ssr.cjs',
      {}
    );
    expect(result.get()().default).toEqual([Array, Object, globalThis]);
    expect(Object.keys(createRequire(import.meta.url).cache)).toEqual(before);
  });

  it('uses the host copy of CommonJS externals', async () => {
    const result = await evaluateSsrCommonJs(
      'module.exports = { init() {}, get() { return () => require("node:path"); } };',
      'http://remote.test/remoteEntry.ssr.cjs',
      {}
    );
    expect(result.get()()).toBe(createRequire(import.meta.url)('node:path'));
  });

  it('uses the require condition of the selected dual package and rejects ESM-only packages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mf-dual-'));
    try {
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({
          name: 'mf-dual',
          type: 'module',
          exports: { import: './esm.js', require: './cjs.cjs' },
        })
      );
      await writeFile(join(root, 'esm.js'), 'export const condition = "import";');
      await writeFile(join(root, 'cjs.cjs'), 'module.exports = { condition: "require" };');
      const source =
        'const shared = require("mf-dual"); module.exports = { init() {}, get: () => shared };';
      const result = await evaluateSsrCommonJs(source, 'http://remote.test/a.cjs', {
        'mf-dual': join(root, 'esm.js'),
      });
      expect(result.get()).toEqual({ condition: 'require' });
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ name: 'mf-esm', type: 'module', exports: './esm.js' })
      );
      await expect(
        evaluateSsrCommonJs(source.replace('mf-dual', 'mf-esm'), 'http://remote.test/a.cjs', {
          'mf-esm': join(root, 'esm.js'),
        })
      ).rejects.toThrow(/ESM-only external.*provide a CommonJS require export/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves wildcard shares from the selected installation outside cwd, including nested format boundaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mf-prefix-'));
    const link = `${root}-link`;
    try {
      await mkdir(join(root, 'dist', 'cjs'), { recursive: true });
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({
          name: 'mf-prefix',
          type: 'module',
          exports: {
            '.': { import: './esm.mjs', require: './dist/cjs/index.js' },
            './sub': { import: './esm.mjs', require: './dist/cjs/sub.js' },
          },
        })
      );
      await writeFile(join(root, 'esm.mjs'), 'export default "import";');
      await writeFile(join(root, 'dist', 'cjs', 'package.json'), '{"type":"commonjs"}');
      await writeFile(
        join(root, 'dist', 'cjs', 'index.js'),
        'module.exports = { value: "selected root" };'
      );
      await writeFile(
        join(root, 'dist', 'cjs', 'sub.js'),
        'module.exports = { value: "selected subpath" };'
      );
      await symlink(root, link, process.platform === 'win32' ? 'junction' : 'dir');
      const source = 'module.exports = { init() {}, get: () => require("mf-prefix/sub") };';
      const selected = await evaluateSsrCommonJs(source, 'https://remote.test/a.cjs', {
        'mf-prefix/': join(link, 'esm.mjs'),
      });
      expect(selected.get()).toEqual({ value: 'selected subpath' });
      const dual = await evaluateSsrCommonJs(
        source.replace('mf-prefix/sub', 'mf-prefix'),
        'https://remote.test/a.cjs',
        {
          'mf-prefix': join(link, 'esm.mjs'),
        }
      );
      expect(dual.get()).toEqual({ value: 'selected root' });
    } finally {
      await rm(link, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['./chunk.cjs', '../chunk.cjs', '/tmp/chunk.cjs', 'file:///tmp/chunk.cjs'])(
    'rejects unbundled build dependencies: %s',
    async (specifier) => {
      await expect(
        evaluateSsrCommonJs(
          `require(${JSON.stringify(specifier)}); module.exports = { init() {}, get() {} };`,
          'http://remote.test/remoteEntry.ssr.cjs',
          {}
        )
      ).rejects.toThrow(/fully bundled/);
    }
  );

  it('rejects invalid containers and reports evaluation failures', async () => {
    await expect(
      evaluateSsrCommonJs('module.exports = {};', 'http://remote.test/a.cjs', {})
    ).rejects.toThrow(/init.*get/);
    await expect(
      evaluateSsrCommonJs('throw Error("broken release")', 'http://remote.test/a.cjs', {})
    ).rejects.toThrow('broken release');
  });
});

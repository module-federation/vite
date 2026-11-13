import { parseAst } from 'rollup/parseAst';
import { describe, expect, it } from 'vitest';
import type { Rollup } from 'vite';
import { buildSsrCjs } from '../buildSsrCjs';
import { evaluateSsrCommonJs } from '../ssrCjsStrategy';

function bundle(files: Record<string, string>): Rollup.OutputBundle {
  return Object.fromEntries(
    Object.entries(files).map(([fileName, source]) => [
      fileName,
      {
        type: 'asset',
        fileName,
        source,
      },
    ])
  ) as Rollup.OutputBundle;
}

describe('CommonJS SSR companion producer', () => {
  it('bundles lazy SSR chunks into one in-memory container', async () => {
    const source = await buildSsrCjs(
      bundle({
        'nested/entry.cjs':
          'export async function init() {} export async function get() { const m = await import("../widget.js"); return () => m; }',
        'widget.js': 'export default "built widget"; export const realm = Array;',
      }),
      'nested/entry.cjs',
      parseAst
    );
    expect(source).not.toMatch(/\bimport\s*\(/);
    const container = await evaluateSsrCommonJs(source, 'http://remote.test/nested/entry.cjs', {});
    const module = (await container.get())();
    expect(module.default).toBe('built widget');
    expect(module.realm).toBe(Array);
  });

  it.each([
    ['import.meta', 'export const url = import.meta.url;'],
    ['fully bundled', 'require("./leftover.cjs"); export const init = () => {};'],
    ['native dynamic import', 'export const get = () => import("node:path");'],
    ['top-level await', 'await Promise.resolve(); export const init = () => {};'],
  ])('rejects unsupported %s', async (label, source) => {
    await expect(buildSsrCjs(bundle({ 'entry.js': source }), 'entry.js', parseAst)).rejects.toThrow(
      label
    );
  });

  it('does not interpret comments and string literals as unsupported syntax', async () => {
    const source = await buildSsrCjs(
      bundle({
        'entry.js':
          '/* import.meta */ export const init = () => {}; export const get = () => "require(./missing) import.meta import(whatever)";',
      }),
      'entry.js',
      parseAst
    );
    expect(source).toContain('import.meta');
  });
});

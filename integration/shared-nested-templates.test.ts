import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPackageDetectionCwd, setPackageDetectionCwd } from '../src/utils/packageUtils';
import { buildFixture } from './helpers/build';
import { getAllChunkCode } from './helpers/matchers';

describe('shared modules with nested templates', () => {
  let root: string;
  let previousCwd: string;

  beforeEach(() => {
    previousCwd = getPackageDetectionCwd();
    root = mkdtempSync(path.resolve('node_modules/.shared-nested-templates-'));
    const packageDir = path.join(root, 'node_modules/shared-demo');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(path.join(root, 'index.html'), '<script type="module" src="/main.js"></script>');
    writeFileSync(
      path.join(root, 'main.js'),
      "import { answer } from 'shared-demo'; console.log(answer);"
    );
    writeFileSync(
      path.join(packageDir, 'package.json'),
      JSON.stringify({
        name: 'shared-demo',
        version: '1.0.0',
        type: 'module',
        exports: './index.js',
      })
    );
    setPackageDetectionCwd(root);
  });

  afterEach(() => {
    setPackageDetectionCwd(previousCwd);
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['single quotes', "const text = `${`'`}`; export const answer = text.length;"],
    ['double quotes', 'const text = `${`"`}`; export const answer = text.length;'],
    [
      'a regex after a condition',
      'const text = `${ (() => { if (true) /"/.test("x"); })() }`; export const answer = 1;',
    ],
  ])('preserves named exports after a template containing %s', async (_name, source) => {
    writeFileSync(path.join(root, 'node_modules/shared-demo/index.js'), source);

    const output = await buildFixture({
      mfOptions: {
        name: 'nestedTemplateProvider',
        manifest: false,
        shared: { 'shared-demo': { singleton: true } },
      },
      viteConfig: { root, configFile: false, build: { target: 'esnext' } },
    });

    const code = getAllChunkCode(output);
    expect(code).toContain('default:shared-demo');
    expect(code).toContain('answer');
  });
});

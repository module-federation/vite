import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModuleFederationOptions } from '../src/utils/normalizeModuleFederationOptions';
import { getPackageDetectionCwd, setPackageDetectionCwd } from '../src/utils/packageUtils';
import { buildFixture } from './helpers/build';
import { getAllChunkCode, parseManifest } from './helpers/matchers';

describe('shared version inference', () => {
  let root: string;
  let previousCwd: string;

  function write(relativePath: string, content: string) {
    const file = path.join(root, relativePath);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  beforeEach(() => {
    previousCwd = getPackageDetectionCwd();
    root = mkdtempSync(path.resolve('node_modules/.shared-version-'));
    write(
      'package.json',
      JSON.stringify({
        name: 'version-inference-app',
        type: 'module',
        dependencies: { 'version-lib': '~1.2.0', 'replacement-lib': '~3.4.0' },
      })
    );
    for (const [name, version] of [
      ['version-lib', '1.2.3'],
      ['replacement-lib', '3.4.5'],
    ]) {
      write(
        `node_modules/${name}/package.json`,
        JSON.stringify({ name, version, type: 'module', main: './index.js' })
      );
      write(`node_modules/${name}/index.js`, `export const value = ${JSON.stringify(name)};`);
    }
    write('index.html', '<script type="module" src="/main.js"></script>');
    write('main.js', 'import { value } from "version-lib"; console.log(value);');
    setPackageDetectionCwd(root);
  });

  afterEach(() => {
    setPackageDetectionCwd(previousCwd);
    rmSync(root, { recursive: true, force: true });
  });

  async function buildShared(shared: ModuleFederationOptions['shared']) {
    return buildFixture({
      mfOptions: { name: 'versionInference', shared, manifest: true },
      viteConfig: { root, configFile: false },
    });
  }

  it('keeps the declared dependency range separate from the installed provider version', async () => {
    const output = await buildShared(['version-lib']);
    expect(parseManifest(output)).toMatchObject({
      shared: [{ name: 'version-lib', version: '1.2.3', requiredVersion: '~1.2.0' }],
    });
    expect(getAllChunkCode(output)).toContain('requiredVersion: "~1.2.0"');
  });

  it('infers version metadata from the replacement import', async () => {
    const output = await buildShared({ 'version-lib': { import: 'replacement-lib' } });
    expect(parseManifest(output)).toMatchObject({
      shared: [{ name: 'version-lib', version: '3.4.5', requiredVersion: '~3.4.0' }],
    });
  });

  it('resolves a child project dependency after Vite supplies root', async () => {
    setPackageDetectionCwd(process.cwd());
    const output = await buildShared({ 'version-lib': { singleton: true } });
    expect(parseManifest(output)).toMatchObject({
      shared: [{ name: 'version-lib', version: '1.2.3', requiredVersion: '~1.2.0' }],
    });
    expect(getAllChunkCode(output)).toContain('version: "1.2.3"');
  });
});

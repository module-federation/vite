import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { UserConfig } from 'vite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModuleFederationOptions } from '../src/utils/normalizeModuleFederationOptions';
import { getPackageDetectionCwd, setPackageDetectionCwd } from '../src/utils/packageUtils';
import { buildFixture } from './helpers/build';
import { getAllChunkCode, parseManifest } from './helpers/matchers';

describe('absolute shared imports', () => {
  let root: string;
  let previousCwd: string;

  function write(relativePath: string, content: string) {
    const file = path.join(root, relativePath);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  function packageFile(file: string, installation = 'local') {
    const directory = installation === 'local' ? '' : 'other/';
    return path.join(root, directory, 'node_modules/audit-lib', file);
  }

  beforeEach(() => {
    previousCwd = getPackageDetectionCwd();
    root = mkdtempSync(path.resolve('node_modules/.shared-absolute-'));
    write('package.json', JSON.stringify({ name: 'absolute-imports-app', type: 'module' }));
    write('index.html', '<script type="module" src="/main.js"></script>');
    for (const [directory, installation] of [
      ['', 'local'],
      ['other/', 'other'],
    ]) {
      const packageDir = `${directory}node_modules/audit-lib`;
      write(
        `${packageDir}/package.json`,
        JSON.stringify({
          name: 'audit-lib',
          version: '1.0.0',
          type: 'module',
          exports: { '.': './index.js', './feature': './dist/feature.js', './*': './*' },
        })
      );
      write(`${packageDir}/index.js`, `export const value = '${installation}-root';`);
      write(`${packageDir}/internal.js`, `export const secret = '${installation}-internal';`);
      write(`${packageDir}/dist/feature.js`, `export const feature = '${installation}-feature';`);
    }
    setPackageDetectionCwd(root);
  });

  afterEach(() => {
    setPackageDetectionCwd(previousCwd);
    rmSync(root, { recursive: true, force: true });
  });

  async function buildShared(
    shared: ModuleFederationOptions['shared'],
    source: string,
    viteConfig: UserConfig = {}
  ) {
    write('main.js', source);
    return buildFixture({
      mfOptions: { name: 'absoluteImports', shared, manifest: true },
      viteConfig: { root, configFile: false, ...viteConfig },
    });
  }

  it('shares the resolved entry without replacing internal files or another installation by default', async () => {
    const output = await buildShared(
      { 'audit-lib': { singleton: true } },
      `import { value } from ${JSON.stringify(packageFile('index.js'))};
       import { secret } from ${JSON.stringify(packageFile('internal.js'))};
       import { value as other } from ${JSON.stringify(packageFile('index.js', 'other'))};
       console.log(value, secret, other);`
    );

    expect(parseManifest(output)).toMatchObject({ shared: [{ name: 'audit-lib' }] });
    const code = getAllChunkCode(output);
    expect(code).toContain('local-internal');
    expect(code).toContain('other-root');
  });

  it('matches corresponding root and subpath entries across installations only when opted in', async () => {
    const output = await buildShared(
      {
        'audit-lib': { singleton: true, allowNodeModulesSuffixMatch: true },
        'audit-lib/feature': { allowNodeModulesSuffixMatch: true },
      },
      `import { value } from ${JSON.stringify(packageFile('index.js', 'other'))};
       import { secret } from ${JSON.stringify(packageFile('internal.js', 'other'))};
       import { feature } from ${JSON.stringify(packageFile('dist/feature.js', 'other'))};
       console.log(value, secret, feature);`
    );

    expect(parseManifest(output)).toMatchObject({
      shared: expect.arrayContaining([
        expect.objectContaining({ name: 'audit-lib' }),
        expect.objectContaining({ name: 'audit-lib/feature' }),
      ]),
    });
    const code = getAllChunkCode(output);
    expect(code).toContain('other-internal');
    expect(code).not.toContain('other-root');
    expect(code).not.toContain('other-feature');
  });

  it('uses Vite mainFields when identifying the shared entry', async () => {
    write(
      'node_modules/audit-lib/package.json',
      JSON.stringify({
        name: 'audit-lib',
        version: '1.0.0',
        type: 'module',
        main: './index.js',
        module: './module.js',
      })
    );
    write('node_modules/audit-lib/module.js', "export const value = 'module-entry';");
    const output = await buildShared(
      { 'audit-lib': { singleton: true } },
      `import { value } from ${JSON.stringify(packageFile('index.js'))};
       import { value as moduleValue } from ${JSON.stringify(packageFile('module.js'))};
       console.log(value, moduleValue);`,
      { resolve: { mainFields: ['main'] } }
    );
    expect(parseManifest(output)).toMatchObject({ shared: [{ name: 'audit-lib' }] });
    expect(getAllChunkCode(output)).toContain('module-entry');
  });

  it('leaves raw imports to Vite instead of replacing them with shared modules', async () => {
    const output = await buildShared(
      { 'audit-lib': { allowNodeModulesSuffixMatch: true } },
      `import source from ${JSON.stringify(packageFile('index.js') + '?raw')};
       console.log(source);`
    );
    expect(getAllChunkCode(output)).toContain("export const value = 'local-root'");
  });

  it('preserves the concrete subpath when matching an absolute import against a prefix share', async () => {
    const output = await buildShared(
      { 'audit-lib/': { allowNodeModulesSuffixMatch: true } },
      `import { secret } from ${JSON.stringify(packageFile('internal.js', 'other'))};
       console.log(secret);`
    );

    expect(parseManifest(output)).toMatchObject({ shared: [{ name: 'audit-lib/internal.js' }] });
    const code = getAllChunkCode(output);
    expect(code).toContain('local-internal');
    expect(code).not.toContain('other-internal');
  });
});

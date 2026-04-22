import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import path from 'pathe';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { getInstalledPackageEntry, getInstalledPackageJson } from '../packageUtils';

describe('getInstalledPackageJson', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('finds packages in pnpm store layout when direct resolution fails', () => {
    const packageName = 'mf-test-scheduler';
    const root = mkdtempSync(path.join(tmpdir(), 'mf-vite-pnpm-'));
    tempDirs.push(root);

    mkdirSync(path.join(root, 'apps/host'), { recursive: true });
    mkdirSync(
      path.join(root, `node_modules/.pnpm/${packageName}@0.27.0/node_modules/${packageName}`),
      {
        recursive: true,
      }
    );
    writeFileSync(
      path.join(root, 'apps/host/package.json'),
      JSON.stringify({ name: 'host', type: 'module' })
    );
    writeFileSync(
      path.join(
        root,
        `node_modules/.pnpm/${packageName}@0.27.0/node_modules/${packageName}/package.json`
      ),
      JSON.stringify({ name: packageName, version: '0.27.0' })
    );

    const installed = getInstalledPackageJson(packageName, { cwd: path.join(root, 'apps/host') });

    expect(installed?.packageJson.name).toBe(packageName);
    expect(installed?.path).toContain(
      `/node_modules/.pnpm/${packageName}@0.27.0/node_modules/${packageName}/package.json`
    );
  });

  it('prefers browser conditional exports for installed package entries', () => {
    const packageName = 'mf-test-browser-conditional';
    const root = mkdtempSync(path.join(tmpdir(), 'mf-vite-browser-'));
    tempDirs.push(root);

    const hostDir = path.join(root, 'apps/host');
    const packageDir = path.join(hostDir, 'node_modules', packageName);
    mkdirSync(path.join(packageDir, 'dist'), { recursive: true });
    writeFileSync(path.join(hostDir, 'package.json'), JSON.stringify({ name: 'host' }));
    writeFileSync(
      path.join(packageDir, 'package.json'),
      JSON.stringify({
        name: packageName,
        exports: {
          '.': {
            worker: {
              import: './dist/server.js',
            },
            browser: {
              import: './dist/browser.js',
            },
            import: './dist/browser.js',
          },
        },
      })
    );
    writeFileSync(path.join(packageDir, 'dist/server.js'), 'export const serverOnly = true;');
    writeFileSync(path.join(packageDir, 'dist/browser.js'), 'export const clientOnly = true;');

    const entry = getInstalledPackageEntry(packageName, { cwd: hostDir });

    expect(entry).toBe(path.join(packageDir, 'dist/browser.js'));
  });
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import path from 'pathe';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { getInstalledPackageJson } from '../packageUtils';

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
});

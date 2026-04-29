import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getLocalSharedImportMapPath_temp,
  writeLocalSharedImportMap_temp,
} from '../localSharedImportMap_temp';
import { normalizeModuleFederationOptions } from '../normalizeModuleFederationOptions';
import { packageNameEncode } from '../packageUtils';

describe('localSharedImportMap_temp', () => {
  let tempRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'mf-temp-test-'));
    originalCwd = process.cwd();
    process.chdir(tempRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (existsSync(tempRoot)) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('uses the default .__mf__temp directory under process.cwd()', () => {
    normalizeModuleFederationOptions({ name: 'host-app' });

    const importMapPath = getLocalSharedImportMapPath_temp();

    expect(importMapPath).toEqual(
      path.resolve(
        process.cwd(),
        '.__mf__temp',
        packageNameEncode('host-app'),
        'localSharedImportMap'
      )
    );
  });

  it('honors a custom relative tempDir resolved against process.cwd()', () => {
    normalizeModuleFederationOptions({
      name: 'host-app',
      tempDir: 'node_modules/.cache/mf-temp',
    });

    const importMapPath = getLocalSharedImportMapPath_temp();

    expect(importMapPath).toEqual(
      path.resolve(
        process.cwd(),
        'node_modules/.cache/mf-temp',
        packageNameEncode('host-app'),
        'localSharedImportMap'
      )
    );
    expect(importMapPath.startsWith(process.cwd())).toBe(true);
  });

  it('honors an absolute tempDir as-is', () => {
    const absoluteTemp = path.join(process.cwd(), 'mf-temp-abs');
    normalizeModuleFederationOptions({
      name: 'host-app',
      tempDir: absoluteTemp,
    });

    const importMapPath = getLocalSharedImportMapPath_temp();

    expect(importMapPath).toEqual(
      path.resolve(absoluteTemp, packageNameEncode('host-app'), 'localSharedImportMap')
    );
  });

  it('writes the local shared import map under the resolved tempDir', () => {
    normalizeModuleFederationOptions({
      name: 'host-app',
      tempDir: 'custom-temp-dir',
    });

    writeLocalSharedImportMap_temp('export const usedShared = {}');

    const expectedFile = path.resolve(
      process.cwd(),
      'custom-temp-dir',
      packageNameEncode('host-app'),
      'localSharedImportMap.js'
    );

    expect(existsSync(expectedFile)).toBe(true);
    expect(readFileSync(expectedFile, 'utf-8')).toContain('export const usedShared = {}');
  });
});

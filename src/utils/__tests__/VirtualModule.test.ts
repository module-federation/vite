import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'pathe';
import { tmpdir } from 'os';
import VirtualModule, { getSuffix, assertModuleFound } from '../VirtualModule';
import { normalizeModuleFederationOptions } from '../normalizeModuleFederationOptions';

describe('getSuffix', () => {
  it('returns .js for simple package without extension', () => {
    expect(getSuffix('react')).toBe('.js');
  });

  it('returns .js for scoped package without extension', () => {
    expect(getSuffix('@scope/pkg')).toBe('.js');
  });

  it('returns .js for scoped package with dots in namespace but no file', () => {
    expect(getSuffix('@company.name/pkg')).toBe('.js');
  });

  it('detects correct suffix for file with extension', () => {
    expect(getSuffix('some/path/to/module.ts')).toBe('.ts');
  });

  it('detects correct suffix for scoped package with nested file and extension', () => {
    expect(getSuffix('@scope/pkg/sub/file.jsx')).toBe('.jsx');
  });

  it('handles scoped package with dots in namespace and extension in file', () => {
    expect(getSuffix('@company.name/pkg/utils/helper.tsx')).toBe('.tsx');
  });

  it('returns .js if dot is before namespace', () => {
    expect(getSuffix('.bin/@scope/pkg')).toBe('.js');
  });

  it('returns correct suffix when multiple dots after namespace', () => {
    expect(getSuffix('@scope/pkg/path.to/module.name.mjs')).toBe('.mjs');
  });

  it('returns correct suffix for deep relative path with scoped namespace', () => {
    expect(getSuffix('@scope.with.dots/pkg/deep/util.spec.ts')).toBe('.ts');
  });
});

describe('assertModuleFound', () => {
  it('throws an error when module is not found', () => {
    const tag = '__test_tag__';
    const str = 'non-existent-module';

    expect(() => {
      assertModuleFound(tag, str);
    }).toThrow(
      `Module Federation shared module '${str}' not found. Please ensure it's installed as a dependency in your package.json.`
    );
  });
});

describe('VirtualModule writeSync', () => {
  it('creates missing virtual module directories before writing', () => {
    const root = mkdtempSync(join(tmpdir(), 'mf-vm-'));
    try {
      mkdirSync(join(root, 'node_modules'), { recursive: true });
      normalizeModuleFederationOptions({
        name: 'analytics',
      });
      VirtualModule.setRoot(root);

      const vm = new VirtualModule('mui/styles', '__loadShare__', '.js');
      vm.writeSync('export default 1;');

      expect(existsSync(vm.getPath())).toBe(true);
      expect(readFileSync(vm.getPath(), 'utf8')).toBe('export default 1;');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recreates a previously written virtual module when the file is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'mf-vm-'));
    try {
      mkdirSync(join(root, 'node_modules'), { recursive: true });
      normalizeModuleFederationOptions({
        name: 'analytics',
      });
      VirtualModule.setRoot(root);

      const vm = new VirtualModule('runtimeInit', '__mf_v__', '.js');
      vm.writeSync('export const value = 1;');
      rmSync(vm.getPath(), { force: true });

      vm.writeSync('export const value = 1;');

      expect(existsSync(vm.getPath())).toBe(true);
      expect(readFileSync(vm.getPath(), 'utf8')).toBe('export const value = 1;');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

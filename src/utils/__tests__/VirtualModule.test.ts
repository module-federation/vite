import VirtualModule, {
  assertModuleFound,
  getSuffix,
  MF_OWNER_INFIX,
  normalizeVirtualModuleId,
  toViteEncodedId,
} from '../VirtualModule';
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
  it('stores generated code in memory behind a virtual id', () => {
    normalizeModuleFederationOptions({
      name: 'analytics',
    });

    const vm = new VirtualModule('mui/styles', '__loadShare__', '.js');
    vm.writeSync('export default 1;');

    expect(vm.getImportId()).toMatch(/^virtual:mf:/);
    expect(vm.getResolvedId()).toBe(`\0${vm.getImportId()}`);
    expect(vm.code).toBe('export default 1;');
    expect(VirtualModule.findById(vm.getResolvedId())).toBe(vm);
    expect(VirtualModule.findById(`\0\0${vm.getImportId()}?commonjs-proxy`)).toBe(vm);
    const encodedId = `${toViteEncodedId(vm.getImportId())}?v=1`;
    expect(normalizeVirtualModuleId(encodedId)).toBe(vm.getImportId());
    expect(VirtualModule.findName('__loadShare__', encodedId)).toBe('mui/styles');
    expect(assertModuleFound('__loadShare__', vm.getImportId())).toBe(vm);
  });

  it('keeps the import id well below NAME_MAX for a deeply-scoped/overlong package name', () => {
    normalizeModuleFederationOptions({
      name: 'analytics',
    });

    const longName = `@some-very-long-scope/${'x'.repeat(200)}`;
    const vm = new VirtualModule(longName, '__loadShare__', '.js');
    vm.writeSync('export default 1;');

    const importId = vm.getImportId();
    expect(importId).toMatch(/^virtual:mf:/);
    expect(importId.length).toBeLessThan(200);
    expect(VirtualModule.findName('__loadShare__', importId)).toBe(longName);
    expect(assertModuleFound('__loadShare__', importId)).toBe(vm);
  });

  it('keeps the tag sentinel intact for a long owner-scoped mfName', () => {
    normalizeModuleFederationOptions({ name: 'analytics' });

    const scopeName = `@my-company/very-long-application-name-remote-shell-v2${MF_OWNER_INFIX}281474976710655`;
    const vm = new VirtualModule('react', '__loadShare__', '.js', scopeName);
    vm.writeSync('export default 1;');

    const importId = vm.getImportId();
    expect(importId).toContain('__loadShare__react__loadShare__');
    expect(VirtualModule.findName('__loadShare__', importId)).toBe('react');
    expect(VirtualModule.findModule('__loadShare__', importId)).toBe(vm);
  });
});

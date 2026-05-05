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

describe('VirtualModule.findModule', () => {
  beforeEach(() => {
    normalizeModuleFederationOptions({ name: 'host' });
  });

  it('resolves a module from a bare specifier', () => {
    const vm = new VirtualModule('react', '__loadShare__', '.mjs');
    const id = vm.getImportId();
    expect(VirtualModule.findModule('__loadShare__', id)).toBe(vm);
  });

  it('resolves a module from an absolute path', () => {
    const vm = new VirtualModule('react', '__loadShare__', '.mjs');
    expect(VirtualModule.findModule('__loadShare__', vm.getPath())).toBe(vm);
  });

  it('strips Vite-style query strings before lookup', () => {
    const vm = new VirtualModule('react', '__loadShare__', '.mjs');
    const idWithQuery = `${vm.getImportId()}?import&v=abc`;
    expect(VirtualModule.findModule('__loadShare__', idWithQuery)).toBe(vm);
  });

  it('returns undefined when the tag does not match the registered module', () => {
    new VirtualModule('react', '__loadShare__', '.mjs');
    const vmPrebuild = new VirtualModule('react', '__prebuild__', '.js');
    // Looking up the prebuild file under the loadShare tag must fail.
    expect(VirtualModule.findModule('__loadShare__', vmPrebuild.getImportId())).toBeUndefined();
  });

  it('returns undefined when the input does not encode a known module', () => {
    expect(VirtualModule.findModule('__loadShare__', 'totally-unrelated-string')).toBeUndefined();
  });

  it('decodes encoded subpath names like react/jsx-runtime', () => {
    const vm = new VirtualModule('react/jsx-runtime', '__prebuild__', '.js');
    expect(VirtualModule.findModule('__prebuild__', vm.getImportId())).toBe(vm);
  });

  it('round-trips package names that themselves contain the tag substring', () => {
    // Names like `pkg-with__prebuild__inside` are technically valid npm names.
    // The old regex-based parser would have mis-captured these; structural
    // prefix matching anchors on the known mfName/tag and recovers the full
    // suffix as the package name.
    const vm = new VirtualModule('pkg-with__prebuild__inside', '__prebuild__', '.js');
    expect(VirtualModule.findModule('__prebuild__', vm.getImportId())).toBe(vm);
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
});

describe('VirtualModule getImportId', () => {
  const originalPnp = (process.versions as { pnp?: string }).pnp;

  afterEach(() => {
    if (originalPnp === undefined) {
      delete (process.versions as { pnp?: string }).pnp;
    } else {
      (process.versions as { pnp?: string }).pnp = originalPnp;
    }
  });

  it('returns the bare specifier outside Yarn PnP', () => {
    delete (process.versions as { pnp?: string }).pnp;

    const root = mkdtempSync(join(tmpdir(), 'mf-vm-'));
    try {
      mkdirSync(join(root, 'node_modules'), { recursive: true });
      normalizeModuleFederationOptions({ name: 'host' });
      VirtualModule.setRoot(root);

      const vm = new VirtualModule('react', '__loadShare__', '.mjs');
      const id = vm.getImportId();

      expect(id.startsWith('__mf__virtual/')).toBe(true);
      expect(id.endsWith('.mjs')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns the absolute path under Yarn PnP so PnP cannot reject the bare specifier', () => {
    (process.versions as { pnp?: string }).pnp = '3.0.0';

    const root = mkdtempSync(join(tmpdir(), 'mf-vm-'));
    try {
      mkdirSync(join(root, 'node_modules'), { recursive: true });
      normalizeModuleFederationOptions({ name: 'host' });
      VirtualModule.setRoot(root);

      const vm = new VirtualModule('react', '__loadShare__', '.mjs');
      const id = vm.getImportId();

      expect(id).toBe(vm.getPath());
      expect(id.startsWith('__mf__virtual/')).toBe(false);
      // The encoded module name is still embedded in the absolute path so
      // VirtualModule.findModule's tag-based regex still matches it.
      expect(id).toContain('__loadShare__');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still resolves the encoded module via findModule when the id is an absolute path', () => {
    (process.versions as { pnp?: string }).pnp = '3.0.0';

    const root = mkdtempSync(join(tmpdir(), 'mf-vm-'));
    try {
      mkdirSync(join(root, 'node_modules'), { recursive: true });
      normalizeModuleFederationOptions({ name: 'host' });
      VirtualModule.setRoot(root);

      const vm = new VirtualModule('react', '__loadShare__', '.mjs');
      const id = vm.getImportId();

      expect(VirtualModule.findModule('__loadShare__', id)).toBe(vm);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

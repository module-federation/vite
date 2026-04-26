import { describe, expect, it, vi } from 'vitest';
import { getRemoteVirtualModule, generateRemotes } from '../virtualRemotes';

vi.mock('../../utils/packageUtils', async () => {
  const actual = await vi.importActual<typeof import('../../utils/packageUtils')>(
    '../../utils/packageUtils'
  );
  return {
    ...actual,
    hasPackageDependency: vi.fn(() => false),
  };
});

vi.mock('../virtualRemoteEntry', () => ({
  getHostAutoInitPath: () => '/virtual/hostInit.js',
}));

vi.mock('../../utils/normalizeModuleFederationOptions', () => ({
  getNormalizeModuleFederationOptions: () => ({
    internalName: 'host',
    virtualModuleDir: '__mf__virtual',
  }),
}));

describe('generateRemotes', () => {
  it('uses ESM remote wrapper exports in dev', () => {
    const code = generateRemotes('remote/Button', 'serve');

    expect(code).toContain('const mod = await __mfRemotePending;');
    expect(code).toContain('export const __moduleExports = exportModule;');
    expect(code).not.toContain('module.exports = exportModule');
  });

  it('awaits build remote loading before exporting the module', () => {
    const code = generateRemotes('remote/App', 'build');

    expect(code).toContain('const mod = await __mfRemotePending;');
    expect(code).toContain('export const __moduleExports = exportModule;');
    expect(code).toContain(
      'export default exportModule?.__esModule ? exportModule.default : exportModule.default ?? exportModule'
    );
  });

  it('uses ESM remote wrappers in Rollup build mode', () => {
    const virtual = getRemoteVirtualModule('remote/Card', 'build');

    expect(virtual.getImportId()).toContain('.mjs');
  });

  describe('proxy invariants', () => {
    it('ownKeys includes non-configurable target keys', () => {
      const code = generateRemotes('remote/Proxy', 'serve');

      // The ownKeys trap must include non-configurable target own keys to satisfy the Proxy invariant
      expect(code).toContain('Reflect.ownKeys(proxyTarget)');
      expect(code).toContain('!d.configurable');
      expect(code).toContain('keys.add(k)');
    });

    it('getOwnPropertyDescriptor returns target descriptor for non-configurable props', () => {
      const code = generateRemotes('remote/Proxy', 'serve');

      // The getOwnPropertyDescriptor trap must report non-configurable target props accurately
      expect(code).toContain('getOwnPropertyDescriptor(_target, prop)');
      expect(code).toContain('Object.getOwnPropertyDescriptor(proxyTarget, prop)');
      expect(code).toContain('if (targetDesc && !targetDesc.configurable) return targetDesc;');
    });

    it('proxy still delegates property access to the remote module', () => {
      const code = generateRemotes('remote/Proxy', 'serve');

      // The get trap should proxy properties to the loaded module
      expect(code).toContain('const mod = getModule();');
      expect(code).toContain('return prop in mod ? mod[prop] : mod.default?.[prop];');
    });
  });
});

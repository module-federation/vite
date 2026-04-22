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
});

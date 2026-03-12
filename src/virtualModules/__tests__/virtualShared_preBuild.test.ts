import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShareItem } from '../../utils/normalizeModuleFederationOptions';
import { getSharedProviderImportId, writeLoadShareModule } from '../virtualShared_preBuild';

const { writeSyncSpy } = vi.hoisted(() => ({
  writeSyncSpy: vi.fn(),
}));

// Mock VirtualModule to capture written code
vi.mock('../../utils/VirtualModule', () => {
  return {
    default: class MockVirtualModule {
      getPath = vi.fn(() => '/mock/path.js');
      getImportId = vi.fn(() => 'mock-import-id');
      writeSync = writeSyncSpy;
    },
  };
});

vi.mock('module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('module')>();
  return {
    ...actual,
    createRequire: () => {
      const loader = ((pkg: string) => {
        if (pkg === 'mock-package-with-reserved') {
          return {
            delete: 1, // reserved JS word
            get: 2, // valid name
            request: 3, // valid name
            default: 4, // should be ignored
            __esModule: true, // should be ignored
          };
        }
        if (pkg === 'local-workspace-package') {
          return {};
        }
        return {};
      }) as ((pkg: string) => any) & { resolve: (pkg: string) => string };

      loader.resolve = (pkg: string) => {
        if (pkg === 'local-workspace-package') {
          return '/workspace/packages/local-workspace-package/src/index.ts';
        }
        if (pkg === 'third-party-package') {
          return '/workspace/node_modules/third-party-package/index.js';
        }
        throw new Error(`Cannot resolve ${pkg}`);
      };

      return loader;
    },
  };
});

describe('writeLoadShareModule', () => {
  beforeEach(() => {
    writeSyncSpy.mockClear();
  });

  it('should alias named exports instead of using bare identifiers to avoid syntax errors', () => {
    const pkg = 'mock-package-with-reserved';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '1.0.0',
      shareConfig: {
        singleton: true,
        strictVersion: false,
        requiredVersion: '^1.0.0',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    expect(writeSyncSpy).toHaveBeenCalled();
    const generatedCode = writeSyncSpy.mock.calls[0][0];

    // Destructuring should alias the keys
    // const { delete: __mf_0, get: __mf_1, request: __mf_2 } = exportModule;
    expect(generatedCode).toContain(
      'const { delete: __mf_0, get: __mf_1, request: __mf_2 } = exportModule;'
    );

    // Export uses aliased keys AS the original keys
    // export { __mf_0 as delete, __mf_1 as get, __mf_2 as request };
    expect(generatedCode).toContain(
      'export { __mf_0 as delete, __mf_1 as get, __mf_2 as request };'
    );
  });

  it('returns the local provider path for workspace shared packages', () => {
    expect(getSharedProviderImportId('local-workspace-package')).toBe(
      '/workspace/packages/local-workspace-package/src/index.ts'
    );
  });

  it('falls back to the prebuild import id for node_modules shared packages', () => {
    expect(getSharedProviderImportId('third-party-package')).toBe('mock-import-id');
  });
});

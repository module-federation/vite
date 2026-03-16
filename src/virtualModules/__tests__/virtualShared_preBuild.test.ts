import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShareItem } from '../../utils/normalizeModuleFederationOptions';
import { writeLoadShareModule } from '../virtualShared_preBuild';

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

// Mock module/createRequire to return specific named exports
vi.mock('module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('module')>();
  return {
    ...actual,
    createRequire: () => (pkg: string) => {
      if (pkg === 'mock-package-with-reserved') {
        return {
          delete: 1, // reserved JS word
          get: 2, // valid name
          request: 3, // valid name
          default: 4, // should be ignored
          __esModule: true, // should be ignored
        };
      }
      return {};
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

  it('inlines a build-only initPromise bootstrap without importing runtimeInit', () => {
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
    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain('const __mfPromiseGlobalKey =');
    expect(generatedCode).toContain('const initPromise = __mfPromiseState.initPromise;');
    expect(generatedCode).not.toContain('import { initPromise } from');
    expect(generatedCode).not.toContain('require("mock-import-id")');
  });
});

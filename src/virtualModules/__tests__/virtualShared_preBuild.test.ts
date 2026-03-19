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
    createRequire: () => {
      const resolver = (pkg: string) => {
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
      };
      resolver.resolve = (pkg: string) => {
        return `/node_modules/${pkg}/index.js`;
      };
      return resolver;
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

  it('unwraps default exports for shared ESM modules', () => {
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

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain('export default exportModule.default ?? exportModule;');
  });

  describe('Rolldown dev mode (isRolldown=true, command=serve)', () => {
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

    it('imports prebuild as namespace to handle both CJS and ESM packages', () => {
      writeLoadShareModule(pkg, mockShareItem, 'serve', true);

      const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

      expect(generatedCode).toMatch(/import \* as __mf_prebuild_ns__ from "[^"]+"/);
    });

    it('synchronously initializes exportModule from prebuild with CJS/ESM fallback', () => {
      writeLoadShareModule(pkg, mockShareItem, 'serve', true);

      const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

      expect(generatedCode).toContain(
        'let exportModule = __mf_prebuild_ns__.default ?? __mf_prebuild_ns__'
      );
    });

    it('synchronously destructures named exports before the async loadShare', () => {
      writeLoadShareModule(pkg, mockShareItem, 'serve', true);

      const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;
      const loadShareIndex = generatedCode.indexOf('runtime.loadShare');
      const firstDestructureIndex = generatedCode.indexOf(
        '({ delete: __mf_0, get: __mf_1, request: __mf_2 } = exportModule)'
      );

      expect(firstDestructureIndex).toBeGreaterThan(-1);
      expect(firstDestructureIndex).toBeLessThan(loadShareIndex);
    });

    it('re-destructures named exports after the await resolves', () => {
      writeLoadShareModule(pkg, mockShareItem, 'serve', true);

      const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;
      const awaitIndex = generatedCode.indexOf('await res.then');
      const destructurePattern =
        '({ delete: __mf_0, get: __mf_1, request: __mf_2 } = exportModule)';
      const lastDestructureIndex = generatedCode.lastIndexOf(destructurePattern);

      expect(awaitIndex).toBeGreaterThan(-1);
      expect(lastDestructureIndex).toBeGreaterThan(awaitIndex);
    });

    it('declares __mf_ variables with let so they can be reassigned after await', () => {
      writeLoadShareModule(pkg, mockShareItem, 'serve', true);

      const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

      expect(generatedCode).toContain('let __mf_0, __mf_1, __mf_2');
    });

    it('still calls loadShare asynchronously for runtime shared resolution', () => {
      writeLoadShareModule(pkg, mockShareItem, 'serve', true);

      const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

      expect(generatedCode).toContain('runtime.loadShare("mock-package-with-reserved"');
      expect(generatedCode).toContain('await res.then');
    });

    it('uses export * from prebuild for packages without named exports', () => {
      writeLoadShareModule('unknown-pkg', mockShareItem, 'serve', true);

      const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

      expect(generatedCode).toMatch(/export \* from "[^"]+"/);
      expect(generatedCode).not.toContain('__mf_0');
    });

    it('does not use the Rolldown dev path for build command', () => {
      writeLoadShareModule(pkg, mockShareItem, 'build', true);

      const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

      expect(generatedCode).not.toContain('__mf_prebuild_ns__');
      expect(generatedCode).toContain('const { delete: __mf_0');
    });
  });
});

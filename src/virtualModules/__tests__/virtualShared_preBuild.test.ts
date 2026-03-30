import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShareItem } from '../../utils/normalizeModuleFederationOptions';
import { writeLoadShareModule } from '../virtualShared_preBuild';

const { writeSyncSpy, mfWarnSpy } = vi.hoisted(() => ({
  writeSyncSpy: vi.fn(),
  mfWarnSpy: vi.fn(),
}));
const parseSpy = vi.hoisted(() => vi.fn((source: string) => [[], []]));

const { hasPackageDependencyMock } = vi.hoisted(() => ({
  hasPackageDependencyMock: vi.fn(() => false),
}));

vi.mock('../../utils/logger', () => ({
  mfWarn: mfWarnSpy,
}));

vi.mock('../../utils/packageUtils', () => ({
  hasPackageDependency: hasPackageDependencyMock,
  getPackageDetectionCwd: vi.fn(() => '/repo/apps/remote'),
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

vi.mock('fs', () => ({
  existsSync: vi.fn(
    (filePath: string) =>
      filePath.endsWith('node_modules/mock-package-esm-only/package.json') ||
      filePath.endsWith('/mock-package-esm-only/package.json') ||
      filePath.endsWith('node_modules/mock-package-typeonly/package.json') ||
      filePath.endsWith('/mock-package-typeonly/package.json') ||
      filePath.endsWith('node_modules/mock-package-runtime-type/package.json') ||
      filePath.endsWith('/mock-package-runtime-type/package.json') ||
      filePath.endsWith('node_modules/mock-package-reexport-type/package.json') ||
      filePath.endsWith('/mock-package-reexport-type/package.json') ||
      filePath.endsWith('node_modules/mock-package-generator-export/package.json') ||
      filePath.endsWith('/mock-package-generator-export/package.json')
  ),
  readFileSync: vi.fn((filePath: string) => {
    if (
      filePath.endsWith('node_modules/mock-package-esm-only/package.json') ||
      filePath.endsWith('/mock-package-esm-only/package.json')
    ) {
      return JSON.stringify({
        name: 'mock-package-esm-only',
        exports: {
          './stores': {
            import: './dist/stores.js',
          },
        },
      });
    }
    if (filePath.endsWith('node_modules/mock-package-esm-only/dist/stores.js')) {
      return 'export const useCounter = () => 1; export function useLogger() {}';
    }
    if (
      filePath.endsWith('node_modules/mock-package-typeonly/package.json') ||
      filePath.endsWith('/mock-package-typeonly/package.json')
    ) {
      return JSON.stringify({
        name: 'mock-package-typeonly',
        type: 'module',
        module: './src/index.jsx',
        exports: {
          '.': './src/index.jsx',
        },
      });
    }
    if (filePath.endsWith('node_modules/mock-package-typeonly/src/index.jsx')) {
      return `// __TYPE_ONLY_EXPORT__
export { type TestType, SharedCounter2 } from './foo';`;
    }
    if (
      filePath.endsWith('node_modules/mock-package-runtime-type/package.json') ||
      filePath.endsWith('/mock-package-runtime-type/package.json')
    ) {
      return JSON.stringify({
        name: 'mock-package-runtime-type',
        type: 'module',
        module: './src/index.js',
        exports: {
          '.': './src/index.js',
        },
      });
    }
    if (filePath.endsWith('node_modules/mock-package-runtime-type/src/index.js')) {
      return `// __RUNTIME_TYPE_EXPORT__
export const type = 1;
export const other = 2;`;
    }
    if (
      filePath.endsWith('node_modules/mock-package-reexport-type/package.json') ||
      filePath.endsWith('/mock-package-reexport-type/package.json')
    ) {
      return JSON.stringify({
        name: 'mock-package-reexport-type',
        type: 'module',
        module: './src/index.js',
        exports: {
          '.': './src/index.js',
        },
      });
    }
    if (filePath.endsWith('node_modules/mock-package-reexport-type/src/index.js')) {
      return `// __RUNTIME_REEXPORT_TYPE__
export { type, other } from './foo';`;
    }
    if (
      filePath.endsWith('node_modules/mock-package-generator-export/package.json') ||
      filePath.endsWith('/mock-package-generator-export/package.json')
    ) {
      return JSON.stringify({
        name: 'mock-package-generator-export',
        type: 'module',
        module: './src/index.js',
        exports: {
          '.': './src/index.js',
        },
      });
    }
    if (filePath.endsWith('node_modules/mock-package-generator-export/src/index.js')) {
      return `export function*loader() {
  yield 1;
}`;
    }
    throw new Error(`Unexpected readFileSync path: ${filePath}`);
  }),
}));

// Mock module/createRequire to return specific named exports
vi.mock('module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('module')>();
  return {
    ...actual,
    createRequire: (from: string | URL) => {
      const fromPath = String(from);
      const req = ((pkg: string) => {
        if (pkg === 'es-module-lexer') {
          return {
            initSync: vi.fn(),
            parse: parseSpy.mockImplementation((source: string) => {
              if (source.includes('useCounter')) {
                return [[], [{ n: 'useCounter' }, { n: 'useLogger' }, { n: 'default' }]];
              }
              if (source.includes('__TYPE_ONLY_EXPORT__')) {
                return [[], [{ n: 'type' }]];
              }
              if (source.includes('__RUNTIME_TYPE_EXPORT__')) {
                return [[], [{ n: 'type' }, { n: 'other' }]];
              }
              if (source.includes('__RUNTIME_REEXPORT_TYPE__')) {
                return [[], [{ n: 'type' }]];
              }
              return [[], []];
            }),
          };
        }
        if (pkg === 'mock-package-with-reserved') {
          return {
            delete: 1,
            get: 2,
            request: 3,
            default: 4,
            __esModule: true,
          };
        }
        if (pkg === 'mock-package-unicode') {
          return {
            ångstrom: 1,
            café: 2,
            default: 3,
            __esModule: true,
          };
        }
        if (pkg === 'transitive-pkg') {
          throw new Error('MODULE_NOT_FOUND');
        }
        if (pkg === 'mock-package-esm-only/stores') {
          const error = new Error('ERR_PACKAGE_PATH_NOT_EXPORTED');
          (error as Error & { code?: string }).code = 'ERR_PACKAGE_PATH_NOT_EXPORTED';
          throw error;
        }
        if (pkg === 'mock-package-typeonly' || pkg.startsWith('mock-package-typeonly/')) {
          const error = new Error('ERR_REQUIRE_ESM');
          (error as Error & { code?: string }).code = 'ERR_REQUIRE_ESM';
          throw error;
        }
        if (pkg === 'mock-package-runtime-type' || pkg.startsWith('mock-package-runtime-type/')) {
          const error = new Error('ERR_REQUIRE_ESM');
          (error as Error & { code?: string }).code = 'ERR_REQUIRE_ESM';
          throw error;
        }
        if (pkg === 'mock-package-reexport-type' || pkg.startsWith('mock-package-reexport-type/')) {
          const error = new Error('ERR_REQUIRE_ESM');
          (error as Error & { code?: string }).code = 'ERR_REQUIRE_ESM';
          throw error;
        }
        if (
          pkg === 'mock-package-generator-export' ||
          pkg.startsWith('mock-package-generator-export/')
        ) {
          const error = new Error('ERR_REQUIRE_ESM');
          (error as Error & { code?: string }).code = 'ERR_REQUIRE_ESM';
          throw error;
        }
        return {};
      }) as NodeJS.Require;

      req.resolve = (pkg: string) => {
        if (pkg === 'transitive-pkg') {
          if (!fromPath.includes('/repo/package.json')) {
            throw new Error('MODULE_NOT_FOUND');
          }
          return '/repo/packages/pkg-b/dist/index.js';
        }
        if (pkg === 'mock-package-esm-only/stores' || pkg === 'mock-package-esm-only') {
          return '/repo/apps/remote/node_modules/mock-package-esm-only/dist/stores.js';
        }
        if (pkg === 'mock-package-typeonly' || pkg.startsWith('mock-package-typeonly/')) {
          return '/repo/apps/remote/node_modules/mock-package-typeonly/src/index.jsx';
        }
        if (pkg === 'mock-package-runtime-type' || pkg.startsWith('mock-package-runtime-type/')) {
          return '/repo/apps/remote/node_modules/mock-package-runtime-type/src/index.js';
        }
        if (pkg === 'workspace-shared-lib') {
          return '/repo/packages/workspace-shared-lib/src/index.tsx';
        }
        if (pkg === 'mock-package-reexport-type' || pkg.startsWith('mock-package-reexport-type/')) {
          return '/repo/apps/remote/node_modules/mock-package-reexport-type/src/index.js';
        }
        if (
          pkg === 'mock-package-generator-export' ||
          pkg.startsWith('mock-package-generator-export/')
        ) {
          return '/repo/apps/remote/node_modules/mock-package-generator-export/src/index.js';
        }
        return `/resolved/${pkg}`;
      };

      return req;
    },
  };
});

describe('writeLoadShareModule', () => {
  beforeEach(() => {
    writeSyncSpy.mockClear();
    mfWarnSpy.mockClear();
    hasPackageDependencyMock.mockReset();
    hasPackageDependencyMock.mockReturnValue(false);
    parseSpy.mockClear();
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

  it('uses shareConfig.import as the concrete import source when provided', () => {
    const pkg = 'transitive-pkg';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '1.0.0',
      shareConfig: {
        import: '/abs/pkg-b/dist/index.js',
        singleton: true,
        strictVersion: false,
        requiredVersion: '^1.0.0',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain('import "/abs/pkg-b/dist/index.js";');
    expect(generatedCode).toContain('export * from "/abs/pkg-b/dist/index.js"');
    expect(generatedCode).not.toContain('import "mock-import-id";');
  });

  it('uses SSR provider fallback for react in Astro build output', () => {
    hasPackageDependencyMock.mockImplementation((pkg: string) => pkg === 'astro');

    const pkg = 'react';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '19.2.4',
      shareConfig: {
        singleton: true,
        strictVersion: false,
        requiredVersion: '^19.2.4',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain('const providerModulePromise = typeof window === "undefined"');
    expect(generatedCode).toContain(
      '? ((await providerModulePromise)?.default ?? await providerModulePromise)'
    );
  });

  it('falls back to parsing ESM exports when require() cannot load the shared package', () => {
    const pkg = 'mock-package-esm-only/stores';
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

    expect(generatedCode).toContain(
      'const { useCounter: __mf_0, useLogger: __mf_1 } = exportModule;'
    );
    expect(generatedCode).toContain('export { __mf_0 as useCounter, __mf_1 as useLogger };');
    expect(generatedCode).not.toContain('export * from');
  });

  it('keeps valid Unicode named exports when generating shared wrappers', () => {
    const pkg = 'mock-package-unicode';
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

    expect(generatedCode).toContain('const { ångstrom: __mf_0, café: __mf_1 } = exportModule;');
    expect(generatedCode).toContain('export { __mf_0 as ångstrom, __mf_1 as café };');
  });

  it('does not reference prebuild modules when import: false', () => {
    const pkg = 'host-only-dep';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: undefined,
      shareConfig: {
        import: false,
        singleton: true,
        strictVersion: false,
        requiredVersion: '*',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'serve', false);

    expect(writeSyncSpy).toHaveBeenCalled();
    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    // Should not have any static import statement (no prebuild to import)
    expect(generatedCode).not.toMatch(/import\s+["']/);
    // Should not have export * (no local source to re-export from)
    expect(generatedCode).not.toContain('export *');
    // Should still call loadShare via the runtime
    expect(generatedCode).toContain('runtime.loadShare');
    // CJS serve mode uses module.exports
    expect(generatedCode).toContain('module.exports = exportModule');
  });

  it('does not reference prebuild modules when import: false in build mode', () => {
    const pkg = 'host-only-dep';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: undefined,
      shareConfig: {
        import: false,
        singleton: true,
        strictVersion: false,
        requiredVersion: '*',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    expect(writeSyncSpy).toHaveBeenCalled();
    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).not.toContain('__prebuild__');
    expect(generatedCode).not.toContain('export *');
    expect(generatedCode).toContain('runtime.loadShare');
    expect(generatedCode).toContain('export default exportModule');
  });

  it('generates named re-exports for import: false when package is installed as devDependency', () => {
    // mock-package-with-reserved is resolvable in the test mock setup
    const pkg = 'mock-package-with-reserved';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: undefined,
      shareConfig: {
        import: false,
        singleton: true,
        strictVersion: false,
        requiredVersion: '*',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    expect(writeSyncSpy).toHaveBeenCalled();
    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    // Should NOT reference prebuild modules
    expect(generatedCode).not.toContain('__prebuild__');
    // Should still use loadShare runtime
    expect(generatedCode).toContain('runtime.loadShare');
    // Should have named exports destructured from the runtime-provided module
    expect(generatedCode).toContain('__mf_0 as delete');
    expect(generatedCode).toContain('__mf_1 as get');
    expect(generatedCode).toContain('__mf_2 as request');
    expect(generatedCode).toContain('export default exportModule');
  });

  it('falls back to default-only export for import: false when package is not installed', () => {
    // host-only-dep is NOT resolvable in the test mock setup
    const pkg = 'host-only-dep';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: undefined,
      shareConfig: {
        import: false,
        singleton: true,
        strictVersion: false,
        requiredVersion: '*',
      },
      scope: 'default',
    };

    mfWarnSpy.mockClear();
    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    expect(writeSyncSpy).toHaveBeenCalled();
    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    // No named export destructuring — package not installed, can't detect exports
    expect(generatedCode).not.toMatch(/const\s*\{.*__mf_\d+/);
    expect(generatedCode).not.toContain('export {');
    // Only default export
    expect(generatedCode).toContain('export default exportModule');
    // Should warn about missing named exports in ESM build
    expect(mfWarnSpy).toHaveBeenCalledWith(expect.stringContaining('not installed locally'));
    expect(mfWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Install it as a devDependency')
    );
  });

  it('auto-detects workspace package entry when the shared dep is not directly resolvable', () => {
    const pkg = 'transitive-pkg';
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

    expect(generatedCode).toContain('import "/repo/packages/pkg-b/dist/index.js";');
    expect(generatedCode).toContain('export * from "/repo/packages/pkg-b/dist/index.js"');
    expect(generatedCode).not.toContain('import "mock-import-id";');
  });

  it('detects runtime exports from export { type X, Y } syntax', () => {
    const pkg = 'mock-package-typeonly';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '1.0.0',
      shareConfig: {
        import: false,
        singleton: true,
        strictVersion: false,
        requiredVersion: '^1.0.0',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(parseSpy).toHaveBeenCalledWith(
      expect.stringContaining('__TYPE_ONLY_EXPORT__'),
      expect.anything()
    );
    expect(generatedCode).toContain('const { SharedCounter2: __mf_0 } = exportModule;');
    expect(generatedCode).toContain('export { __mf_0 as SharedCounter2 };');
    expect(generatedCode).not.toContain('as type');
    expect(mfWarnSpy).not.toHaveBeenCalled();
  });

  it('preserves legitimate runtime exports named type', () => {
    const pkg = 'mock-package-runtime-type';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '1.0.0',
      shareConfig: {
        import: false,
        singleton: true,
        strictVersion: false,
        requiredVersion: '^1.0.0',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain('const { type: __mf_0, other: __mf_1 } = exportModule;');
    expect(generatedCode).toContain('export { __mf_0 as type, __mf_1 as other };');
  });

  it('preserves legitimate bare re-exports named type', () => {
    const pkg = 'mock-package-reexport-type';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '1.0.0',
      shareConfig: {
        import: false,
        singleton: true,
        strictVersion: false,
        requiredVersion: '^1.0.0',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain('const { type: __mf_0, other: __mf_1 } = exportModule;');
    expect(generatedCode).toContain('export { __mf_0 as type, __mf_1 as other };');
  });

  it('detects generator function exports via regex fallback, including function* spacing variations', () => {
    const pkg = 'mock-package-generator-export';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '1.0.0',
      shareConfig: {
        import: false,
        singleton: true,
        strictVersion: false,
        requiredVersion: '^1.0.0',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain('const { loader: __mf_0 } = exportModule;');
    expect(generatedCode).toContain('export { __mf_0 as loader };');
  });

  it('does not emit duplicate side-effect imports for workspace singletons in serve mode', () => {
    const pkg = 'workspace-shared-lib';
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

    writeLoadShareModule(pkg, mockShareItem, 'serve', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).not.toContain('import "mock-import-id";');
    expect(generatedCode).not.toContain('import("workspace-shared-lib")');
  });

  it('does not emit duplicate side-effect imports for parent-root workspace packages in serve mode', () => {
    const pkg = 'transitive-pkg';
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

    writeLoadShareModule(pkg, mockShareItem, 'serve', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).not.toContain('import "/repo/packages/pkg-b/dist/index.js";');
    expect(generatedCode).not.toContain('import("transitive-pkg")');
  });
});

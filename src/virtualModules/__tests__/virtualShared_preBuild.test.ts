import type { ExportSpecifier, ImportSpecifier, parse as parseEsmModule } from 'es-module-lexer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShareItem } from '../../utils/normalizeModuleFederationOptions';
import {
  getProjectResolvedImportPath,
  writeLoadShareModule,
  writePreBuildLibPath,
} from '../virtualShared_preBuild';

const { writeSyncSpy, mfWarnSpy } = vi.hoisted(() => ({
  writeSyncSpy: vi.fn(),
  mfWarnSpy: vi.fn(),
}));
const parseSpy = vi.hoisted(() =>
  vi.fn<typeof parseEsmModule>((() => [[], []]) as unknown as typeof parseEsmModule)
);

const { hasPackageDependencyMock } = vi.hoisted(() => ({
  hasPackageDependencyMock: vi.fn<(pkg: string) => boolean>(() => false),
}));

type MockRequire = NodeJS.Require & {
  resolve: NodeJS.RequireResolve;
};

type ParseResult = ReturnType<typeof parseEsmModule>;

function createParseResult(names: string[]): ParseResult {
  return [
    [] as ImportSpecifier[],
    names.map((name) => ({ n: name }) as ExportSpecifier),
    false,
    true,
  ];
}

vi.mock('../../utils/logger', () => ({
  mfWarn: mfWarnSpy,
}));

vi.mock('../../utils/packageUtils', () => ({
  hasPackageDependency: hasPackageDependencyMock,
  getPackageDetectionCwd: vi.fn(() => '/repo/apps/remote'),
  getInstalledPackageEntry: vi.fn((pkg: string) => {
    if (pkg === 'mock-package-esm-only/stores' || pkg === 'mock-package-esm-only') {
      return '/repo/apps/remote/node_modules/mock-package-esm-only/dist/stores.js';
    }
    if (pkg === 'mock-package-subpath/feature') {
      return '/repo/apps/remote/node_modules/mock-package-subpath/dist/browser-feature.js';
    }
    if (pkg === 'lit') return '/repo/apps/remote/node_modules/lit/index.js';
    if (pkg === 'lit/directives/class-map.js') {
      return '/repo/apps/remote/node_modules/lit/directives/class-map.js';
    }
    if (pkg === 'mock-package-typeonly' || pkg.startsWith('mock-package-typeonly/')) {
      return '/repo/apps/remote/node_modules/mock-package-typeonly/src/index.jsx';
    }
    if (pkg === 'mock-package-runtime-type' || pkg.startsWith('mock-package-runtime-type/')) {
      return '/repo/apps/remote/node_modules/mock-package-runtime-type/src/index.js';
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
    if (
      pkg === 'mock-package-browser-conditional' ||
      pkg.startsWith('mock-package-browser-conditional/')
    ) {
      return '/repo/apps/remote/node_modules/mock-package-browser-conditional/dist/browser.js';
    }
    if (pkg === 'workspace-shared-lib') {
      return '/repo/packages/workspace-shared-lib/src/index.tsx';
    }
    if (pkg === 'workspace-esm-symlink') {
      return '/repo/apps/remote/node_modules/workspace-esm-symlink/src/index.ts';
    }
  }),
  getInstalledPackageJson: vi.fn((pkg: string, opts?: { fromResolvedEntry?: string }) => {
    if (opts?.fromResolvedEntry?.includes('/repo/packages/workspace-shared-lib/')) {
      return {
        path: '/repo/packages/workspace-shared-lib/package.json',
        dir: '/repo/packages/workspace-shared-lib',
        packageJson: { name: 'workspace-shared-lib' },
      };
    }
    if (
      opts?.fromResolvedEntry?.includes('/repo/apps/remote/node_modules/workspace-esm-symlink/')
    ) {
      return {
        path: '/repo/packages/workspace-esm-symlink/package.json',
        dir: '/repo/packages/workspace-esm-symlink',
        packageJson: { name: 'workspace-esm-symlink' },
      };
    }
    if (pkg === 'mock-package-browser-conditional') {
      return {
        path: '/repo/apps/remote/node_modules/mock-package-browser-conditional/package.json',
        dir: '/repo/apps/remote/node_modules/mock-package-browser-conditional',
        packageJson: {
          name: 'mock-package-browser-conditional',
          exports: {
            '.': {
              worker: {
                import: './dist/server.js',
              },
              browser: {
                import: './dist/browser.js',
              },
              import: './dist/browser.js',
            },
          },
        },
      };
    }
  }),
  getPackageName: (packageString: string) => {
    const match = packageString.match(/^(?:@[^/]+\/)?[^/]+/);
    return match ? match[0] : packageString;
  },
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
      filePath.endsWith('node_modules/lit/package.json') ||
      filePath.endsWith('/lit/package.json') ||
      filePath.endsWith('node_modules/lit/index.js') ||
      filePath.endsWith('/lit/index.js') ||
      filePath.endsWith('node_modules/lit/directives/class-map.js') ||
      filePath.endsWith('/lit/directives/class-map.js') ||
      filePath.endsWith('node_modules/mock-package-esm-only/package.json') ||
      filePath.endsWith('/mock-package-esm-only/package.json') ||
      filePath.endsWith('node_modules/mock-package-typeonly/package.json') ||
      filePath.endsWith('/mock-package-typeonly/package.json') ||
      filePath.endsWith('node_modules/mock-package-runtime-type/package.json') ||
      filePath.endsWith('/mock-package-runtime-type/package.json') ||
      filePath.endsWith('node_modules/mock-package-reexport-type/package.json') ||
      filePath.endsWith('/mock-package-reexport-type/package.json') ||
      filePath.endsWith('node_modules/mock-package-generator-export/package.json') ||
      filePath.endsWith('/mock-package-generator-export/package.json') ||
      filePath.endsWith('node_modules/mock-package-browser-conditional/package.json') ||
      filePath.endsWith('/mock-package-browser-conditional/package.json') ||
      filePath.endsWith('node_modules/mock-package-browser-conditional/dist/browser.js') ||
      filePath.endsWith('/mock-package-browser-conditional/dist/browser.js') ||
      filePath.endsWith('node_modules/mock-package-browser-conditional/dist/server.js') ||
      filePath.endsWith('/mock-package-browser-conditional/dist/server.js') ||
      filePath.endsWith('/repo/packages/workspace-shared-lib/package.json') ||
      filePath.endsWith('/repo/packages/workspace-name-mismatch/package.json')
  ),
  readFileSync: vi.fn((filePath: string) => {
    if (
      filePath.endsWith('node_modules/lit/package.json') ||
      filePath.endsWith('/lit/package.json')
    ) {
      return JSON.stringify({
        name: 'lit',
        exports: {
          '.': './index.js',
          './directives/class-map.js': './directives/class-map.js',
        },
      });
    }
    if (filePath.endsWith('node_modules/lit/index.js') || filePath.endsWith('/lit/index.js')) {
      return 'export const useCounter = () => 1; export function useLogger() {}';
    }
    if (
      filePath.endsWith('node_modules/lit/directives/class-map.js') ||
      filePath.endsWith('/lit/directives/class-map.js')
    ) {
      return 'export const useCounter = () => 1; export function useLogger() {}';
    }
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
    if (
      filePath.endsWith('node_modules/mock-package-browser-conditional/package.json') ||
      filePath.endsWith('/mock-package-browser-conditional/package.json')
    ) {
      return JSON.stringify({
        name: 'mock-package-browser-conditional',
        exports: {
          '.': {
            worker: {
              import: './dist/server.js',
            },
            browser: {
              import: './dist/browser.js',
            },
            import: './dist/browser.js',
          },
        },
      });
    }
    if (filePath.endsWith('node_modules/mock-package-browser-conditional/dist/browser.js')) {
      return 'export const clientOnly = true;';
    }
    if (filePath.endsWith('node_modules/mock-package-browser-conditional/dist/server.js')) {
      return 'export const serverOnly = true;';
    }
    if (filePath.endsWith('/repo/packages/workspace-shared-lib/package.json')) {
      return JSON.stringify({ name: 'workspace-shared-lib' });
    }
    if (filePath.endsWith('/repo/packages/workspace-name-mismatch/package.json')) {
      return JSON.stringify({ name: 'different-package-name' });
    }
    throw new Error(`Unexpected readFileSync path: ${filePath}`);
  }),
  realpathSync: Object.assign(
    vi.fn((filePath: string) =>
      filePath.replace(
        '/repo/apps/remote/node_modules/workspace-esm-symlink',
        '/repo/packages/workspace-esm-symlink'
      )
    ),
    {
      native: vi.fn((filePath: string) =>
        filePath.replace(
          '/repo/apps/remote/node_modules/workspace-esm-symlink',
          '/repo/packages/workspace-esm-symlink'
        )
      ),
    }
  ),
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
                return createParseResult(['useCounter', 'useLogger', 'default']);
              }
              if (source.includes('__TYPE_ONLY_EXPORT__')) {
                return createParseResult(['type']);
              }
              if (source.includes('__RUNTIME_TYPE_EXPORT__')) {
                return createParseResult(['type', 'other']);
              }
              if (source.includes('__RUNTIME_REEXPORT_TYPE__')) {
                return createParseResult(['type']);
              }
              return createParseResult([]);
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
        if (pkg === 'lit' || pkg.startsWith('lit/')) {
          const error = new Error('ERR_REQUIRE_ESM');
          (error as Error & { code?: string }).code = 'ERR_REQUIRE_ESM';
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
        if (
          pkg === 'mock-package-browser-conditional' ||
          pkg.startsWith('mock-package-browser-conditional/')
        ) {
          const error = new Error('ERR_REQUIRE_ESM');
          (error as Error & { code?: string }).code = 'ERR_REQUIRE_ESM';
          throw error;
        }
        return {};
      }) as MockRequire;

      req.resolve = Object.assign(
        (pkg: string) => {
          if (pkg === 'missing-project-only') {
            throw new Error('MODULE_NOT_FOUND');
          }
          if (pkg === 'transitive-pkg') {
            if (!fromPath.includes('/repo/package.json')) {
              throw new Error('MODULE_NOT_FOUND');
            }
            return '/repo/packages/pkg-b/dist/index.js';
          }
          if (pkg === 'mock-package-esm-only/stores' || pkg === 'mock-package-esm-only') {
            return '/repo/apps/remote/node_modules/mock-package-esm-only/dist/stores.js';
          }
          if (pkg === 'mock-package-subpath/feature') {
            return '/repo/apps/remote/node_modules/mock-package-subpath/dist/require-feature.js';
          }
          if (pkg === 'lit') {
            return '/repo/apps/remote/node_modules/lit/index.js';
          }
          if (pkg === 'lit/directives/class-map.js') {
            return '/repo/apps/remote/node_modules/lit/directives/class-map.js';
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
          if (pkg === 'workspace-esm-symlink') {
            const error = new Error('ERR_PACKAGE_PATH_NOT_EXPORTED');
            (error as Error & { code?: string }).code = 'ERR_PACKAGE_PATH_NOT_EXPORTED';
            throw error;
          }
          if (pkg === 'workspace-name-mismatch') {
            return '/repo/packages/workspace-name-mismatch/src/index.ts';
          }
          if (
            pkg === 'mock-package-reexport-type' ||
            pkg.startsWith('mock-package-reexport-type/')
          ) {
            return '/repo/apps/remote/node_modules/mock-package-reexport-type/src/index.js';
          }
          if (
            pkg === 'mock-package-generator-export' ||
            pkg.startsWith('mock-package-generator-export/')
          ) {
            return '/repo/apps/remote/node_modules/mock-package-generator-export/src/index.js';
          }
          if (
            pkg === 'mock-package-browser-conditional' ||
            pkg.startsWith('mock-package-browser-conditional/')
          ) {
            return '/repo/apps/remote/node_modules/mock-package-browser-conditional/dist/server.js';
          }
          return `/resolved/${pkg}`;
        },
        { paths: vi.fn() }
      );

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

  it('inlines a build-only cache bootstrap without importing runtimeInit', () => {
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

    expect(generatedCode).toContain('const __mfCacheGlobalKey =');
    expect(generatedCode).toContain('__mfModuleCache.share["mock-package-with-reserved"]');
    expect(generatedCode).not.toContain('await ');
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

    expect(generatedCode).toContain('import * as __mfLocalShare from "/abs/pkg-b/dist/index.js";');
    expect(generatedCode).toContain('export * from "/abs/pkg-b/dist/index.js"');
    expect(generatedCode).not.toContain('import "mock-import-id";');
  });

  it('uses cache-backed react output for Astro build output', () => {
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

    expect(generatedCode).toContain('__mfModuleCache.share["react"]');
    expect(generatedCode).not.toContain('providerModulePromise');
    expect(generatedCode).not.toContain('await ');
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

    // Should not have any static package import statement (no prebuild to import)
    expect(generatedCode).not.toMatch(/import\s+["']host-only-dep["']/);
    // Should not have export * (no local source to re-export from)
    expect(generatedCode).not.toContain('export *');
    expect(generatedCode).toContain('__mfModuleCache.share["host-only-dep"]');
    expect(generatedCode).toContain('export default exportModule.default ?? exportModule');
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
    expect(generatedCode).toContain('__mfModuleCache.share["host-only-dep"]');
    expect(generatedCode).not.toContain('await ');
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
    expect(generatedCode).toContain('__mfModuleCache.share["mock-package-with-reserved"]');
    // Should have named exports destructured from the runtime-provided module
    expect(generatedCode).toContain('__mf_0 as delete');
    expect(generatedCode).toContain('__mf_1 as get');
    expect(generatedCode).toContain('__mf_2 as request');
    expect(generatedCode).toContain('export default exportModule');
  });

  it('prefers browser conditional exports when detecting shared ESM named exports', () => {
    const pkg = 'mock-package-browser-conditional';
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

    expect(generatedCode).toContain('__mf_0 as clientOnly');
    expect(generatedCode).not.toContain('serverOnly');
  });

  it('prefers browser conditional exports for project-resolved import paths', () => {
    expect(getProjectResolvedImportPath('mock-package-browser-conditional')).toBe(
      '/repo/apps/remote/node_modules/mock-package-browser-conditional/dist/browser.js'
    );
  });

  it('uses project require resolution for package subpath import paths', () => {
    expect(getProjectResolvedImportPath('mock-package-subpath/feature')).toBe(
      '/repo/apps/remote/node_modules/mock-package-subpath/dist/require-feature.js'
    );
  });

  it('falls back to project require resolution when package metadata is unavailable', () => {
    expect(getProjectResolvedImportPath('plain-project-only')).toBe('/resolved/plain-project-only');
  });

  it('returns undefined when project require resolution fails', () => {
    expect(getProjectResolvedImportPath('missing-project-only')).toBeUndefined();
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

    expect(generatedCode).toContain(
      'import * as __mfLocalShare from "/repo/packages/pkg-b/dist/index.js";'
    );
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

  it('does not emit eager side-effect imports for workspace singletons in build mode', () => {
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

    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).not.toContain(
      'import * as __mfLocalShare from "/repo/packages/workspace-shared-lib/src/index.tsx";'
    );
    expect(generatedCode).toContain(
      'exportModule = await import("/repo/packages/workspace-shared-lib/src/index.tsx");'
    );
    expect(generatedCode).not.toContain('__mfLocalShare');
  });

  it('detects symlinked ESM-only workspace singleton fallbacks without eager prebuild imports', () => {
    const pkg = 'workspace-esm-symlink';
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

    expect(generatedCode).not.toContain('import * as __mfLocalShare');
    expect(generatedCode).not.toContain('export * from');
    expect(generatedCode).toContain(
      'exportModule = await import("/repo/apps/remote/node_modules/workspace-esm-symlink/src/index.ts");'
    );
    expect(generatedCode).not.toContain('__mfLocalShare');
  });

  it('does not treat parent package.json name mismatches as workspace package matches', () => {
    const pkg = 'workspace-name-mismatch';
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

    expect(generatedCode).toContain('import * as __mfLocalShare from "mock-import-id";');
    expect(generatedCode).toContain('exportModule = __mfLocalShare;');
    expect(generatedCode).not.toContain(
      'await import("/repo/packages/workspace-name-mismatch/src/index.ts")'
    );
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

  it('generates ESM loadShare wrappers for lit subpath shares in serve mode', () => {
    const pkg = 'lit/directives/class-map.js';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '3.3.2',
      shareConfig: {
        singleton: true,
        strictVersion: false,
        requiredVersion: '^3.3.2',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'serve', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain('const __mfCacheGlobalKey =');
    expect(generatedCode).toContain(
      'import * as __mfLocalShare from "lit/directives/class-map.js";'
    );
    expect(generatedCode).toContain('export default exportModule.default ?? exportModule;');
    expect(generatedCode).toContain('export { __mf_0 as useCounter, __mf_1 as useLogger };');
    expect(generatedCode).not.toContain('__prebuild__');
    expect(generatedCode).not.toContain('import("lit/directives/class-map.js")');
    expect(generatedCode).not.toContain('const {initPromise} = require(');
    expect(generatedCode).not.toContain('await ');
  });

  it('generates ESM loadShare wrappers for lit root share in serve mode', () => {
    const pkg = 'lit';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '3.3.2',
      shareConfig: {
        singleton: true,
        strictVersion: false,
        requiredVersion: '^3.3.2',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'serve', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain('const __mfCacheGlobalKey =');
    expect(generatedCode).toContain('import * as __mfLocalShare from "lit";');
    expect(generatedCode).toContain('export default exportModule.default ?? exportModule;');
    expect(generatedCode).toContain('export { __mf_0 as useCounter, __mf_1 as useLogger };');
    expect(generatedCode).not.toContain('__prebuild__');
    expect(generatedCode).not.toContain('import("lit")');
    expect(generatedCode).not.toContain('const {initPromise} = require(');
    expect(generatedCode).not.toContain('await ');
  });

  it('generates ESM loadShare wrappers for vue root share in serve mode', () => {
    const pkg = 'vue';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '3.5.29',
      shareConfig: {
        singleton: true,
        strictVersion: false,
        requiredVersion: '^3.5.29',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'serve', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain('const __mfCacheGlobalKey =');
    expect(generatedCode).toContain('export default exportModule.default ?? exportModule');
    expect(generatedCode).toContain('export * from');
    expect(generatedCode).not.toContain('module.exports = exportModule');
    expect(generatedCode).not.toContain('await ');
  });
});

describe('writePreBuildLibPath', () => {
  beforeEach(() => {
    writeSyncSpy.mockClear();
  });

  it('writes a real package re-export so Vite optimizeDeps does not prebundle an empty module', () => {
    const pkg = 'ag-grid-react';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '34.1.2',
      shareConfig: {
        singleton: false,
        strictVersion: false,
        requiredVersion: '^34.1.2',
      },
      scope: 'default',
    };

    writePreBuildLibPath(pkg, mockShareItem);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain('import * as __mfPrebuildExports from "ag-grid-react";');
    expect(generatedCode).toContain('export * from "ag-grid-react";');
    expect(generatedCode).toContain(
      'export default __mfPrebuildExports.default ?? __mfPrebuildExports;'
    );
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizePathForImport } from '../../utils/buildPaths';
import {
  normalizeModuleFederationOptions,
  ShareItem,
} from '../../utils/normalizeModuleFederationOptions';
import {
  addTreeShakingGraphQuery,
  getConcreteSharedImportSource,
  getProjectResolvedImportPath,
  getTreeShakingGraphToken,
  getTreeShakingSharedProviderImportId,
  hasTreeShakingSharedProvider,
  writeLoadShareModule,
  writePreBuildLibPath,
  stripTreeShakingGraphQuery,
} from '../virtualShared_preBuild';
import { setTreeShakingBuildMode } from '../../utils/treeShaking';

const { writeSyncSpy, mfWarnSpy } = vi.hoisted(() => ({
  writeSyncSpy: vi.fn(),
  mfWarnSpy: vi.fn(),
}));

const { hasPackageDependencyMock } = vi.hoisted(() => ({
  hasPackageDependencyMock: vi.fn<(pkg: string) => boolean>(() => false),
}));

type MockRequire = NodeJS.Require & {
  resolve: NodeJS.RequireResolve;
};

function expectLiveSingletonProxy(generatedCode: string, pkg: string, namedExports: string[]) {
  const cacheDescriptor = JSON.stringify({
    canonical: `default:${pkg}`,
    aliases: [pkg],
  });
  const exportList = namedExports.map((name, index) => `__mf_${index} as ${name}`).join(', ');

  expect(generatedCode).toContain('let __mfDefaultExport;');
  namedExports.forEach((name, index) => {
    expect(generatedCode).toContain(`let __mf_${index};`);
    expect(generatedCode).toContain(`__mf_${index} = mod[${JSON.stringify(name)}];`);
  });
  expect(generatedCode).toContain('const __mfApplySharedExports = (mod) => {');
  expect(generatedCode).toContain('__mfDefaultExport = (() => {');
  expect(generatedCode).toContain(
    `__mfSubscribeSharedCache(__mfModuleCache.share, ${cacheDescriptor}, __mfApplySharedExports);`
  );
  expect(generatedCode).toContain('__mfApplySharedExports(exportModule);');
  expect(generatedCode).toContain('export { __mfDefaultExport as default };');
  expect(generatedCode).toContain(`export { ${exportList} };`);
  expect(generatedCode).not.toMatch(/const \{[^}]+\} = exportModule;/);
}

describe('tree-shaking graph ids', () => {
  it('adds, reads, replaces, and strips the graph token without losing other query data', () => {
    const tagged = addTreeShakingGraphQuery('/pkg/index.js?raw=true#fragment', '@scope/pkg');

    expect(tagged).toBe('/pkg/index.js?raw=true&__mf_tree_shaking_graph__=%40scope%2Fpkg#fragment');
    expect(getTreeShakingGraphToken(tagged)).toBe('@scope/pkg');
    expect(stripTreeShakingGraphQuery(tagged)).toBe('/pkg/index.js?raw=true#fragment');
    expect(addTreeShakingGraphQuery(tagged, 'replacement')).toBe(
      '/pkg/index.js?raw=true&__mf_tree_shaking_graph__=replacement#fragment'
    );
  });
});

vi.mock('../../utils/logger', () => ({
  mfWarn: mfWarnSpy,
}));

vi.mock('../../utils/packageUtils', () => ({
  getSharedCacheDescriptor: (
    pkg: string,
    shareItem: { version?: string; scope?: string; shareConfig: { singleton?: boolean } }
  ) => {
    const scope = shareItem.scope || 'default';
    const id =
      shareItem.shareConfig.singleton || !shareItem.version ? pkg : `${pkg}@${shareItem.version}`;
    return {
      canonical: `${scope}:${id}`,
      ...(scope === 'default' ? { aliases: [id] } : {}),
    };
  },
  getSharedCacheKey: (
    pkg: string,
    shareItem: { version?: string; scope?: string; shareConfig: { singleton?: boolean } }
  ) => {
    const prefix = `${shareItem.scope || 'default'}:`;
    return shareItem.shareConfig.singleton || !shareItem.version
      ? `${prefix}${pkg}`
      : `${prefix}${pkg}@${shareItem.version}`;
  },
  sharedCacheHelperCode: `const __mfGetSharedCacheDescriptor = (pkg, singleton, version, scope) => {
            const normalizedScope = Array.isArray(scope) ? scope[0] : scope;
            const scopeName = normalizedScope || "default";
            const id = singleton || !version ? pkg : pkg + "@" + version;
            const descriptor = { canonical: scopeName + ":" + id };
            if (scopeName === "default") descriptor.aliases = [id];
            return descriptor;
          };
          const __mfReadSharedCache = (cache, descriptor) => {
            const value = cache[descriptor.canonical];
            if (value !== undefined) return value;
            const aliases = descriptor.aliases || [];
            for (const alias of aliases) {
              if (!Object.prototype.hasOwnProperty.call(cache, alias)) continue;
              const aliasValue = cache[alias];
              if (aliasValue !== undefined) {
                cache[descriptor.canonical] = aliasValue;
                return aliasValue;
              }
            }
            return undefined;
          };
          const __mfSharedCacheListenersKey = Symbol.for("module-federation.shared-cache-listeners");
          const __mfGetSharedCacheListeners = (cache) => {
            let listeners = cache[__mfSharedCacheListenersKey];
            if (listeners === undefined) {
              listeners = Object.create(null);
              Object.defineProperty(cache, __mfSharedCacheListenersKey, {
                value: listeners,
                enumerable: false,
                configurable: false,
                writable: false
              });
            }
            return listeners;
          };
          const __mfSubscribeSharedCache = (cache, descriptor, listener) => {
            const listeners = __mfGetSharedCacheListeners(cache);
            (listeners[descriptor.canonical] ||= new Set()).add(listener);
          };
          const __mfSharedCacheOwnersKey = Symbol.for("module-federation.shared-cache-owners");
          const __mfGetSharedCacheOwners = (cache) => {
            let owners = cache[__mfSharedCacheOwnersKey];
            if (owners === undefined) {
              owners = Object.create(null);
              Object.defineProperty(cache, __mfSharedCacheOwnersKey, {
                value: owners,
                enumerable: false,
                configurable: false,
                writable: false
              });
            }
            return owners;
          };
          const __mfReadSharedCacheOwner = (cache, descriptor) =>
            cache[__mfSharedCacheOwnersKey]?.[descriptor.canonical];
          const __mfWriteSharedCache = (cache, descriptor, value, owner) => {
            cache[descriptor.canonical] = value;
            const aliases = descriptor.aliases || [];
            for (const alias of aliases) {
              Object.defineProperty(cache, alias, {
                value,
                enumerable: true,
                configurable: true,
                writable: true
              });
            }
            const owners = cache[__mfSharedCacheOwnersKey];
            if (owner === undefined) {
              if (owners) delete owners[descriptor.canonical];
            } else {
              __mfGetSharedCacheOwners(cache)[descriptor.canonical] = owner;
            }
            const listeners = cache[__mfSharedCacheListenersKey]?.[descriptor.canonical];
            if (listeners) {
              for (const listener of listeners) listener(value);
            }
            return value;
          };`,
  packageNameEncode: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_'),
  hasPackageDependency: hasPackageDependencyMock,
  getPackageDetectionCwd: vi.fn(() => '/repo/apps/remote'),
  resolveImportPath: vi.fn(() => '/repo/node_modules/@module-federation/runtime/dist/index.js'),
  getInstalledPackageEntry: vi.fn((pkg: string, opts?: { cwd?: string }) => {
    if (pkg === 'react/jsx-runtime') {
      return '/repo/apps/remote/node_modules/react/jsx-runtime.js';
    }
    if (pkg === 'mock-package-star-dependency') {
      return '/repo/apps/remote/node_modules/mock-package-star-dependency/index.js';
    }
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
      pkg === 'mock-package-enum-destructure' ||
      pkg.startsWith('mock-package-enum-destructure/')
    ) {
      return '/repo/apps/remote/node_modules/mock-package-enum-destructure/src/index.js';
    }
    if (
      pkg === 'mock-package-browser-conditional' ||
      pkg.startsWith('mock-package-browser-conditional/')
    ) {
      return '/repo/apps/remote/node_modules/mock-package-browser-conditional/dist/browser.js';
    }
    if (pkg === 'mock-package-dual-shape') {
      return '/repo/apps/remote/node_modules/mock-package-dual-shape/dist/browser.js';
    }
    if (pkg === 'mock-package-cjs-comment') {
      return '/repo/apps/remote/node_modules/mock-package-cjs-comment/index.js';
    }
    if (pkg === 'workspace-shared-lib') {
      return '/repo/packages/workspace-shared-lib/src/index.tsx';
    }
    if (pkg === 'workspace-unknown-exports') {
      return '/repo/packages/workspace-unknown-exports/src/index.ts';
    }
    if (pkg === 'workspace-esm-symlink') {
      return '/repo/apps/remote/node_modules/workspace-esm-symlink/src/index.ts';
    }
    if (pkg === 'workspace-cycle-a') {
      return '/repo/packages/workspace-cycle-a/src/index.ts';
    }
    if (pkg === 'workspace-cycle-b') {
      return '/repo/packages/workspace-cycle-b/src/index.ts';
    }
    if (pkg === 'workspace-producer' || pkg.startsWith('workspace-producer/')) {
      return '/repo/packages/workspace-producer/src/index.ts';
    }
    if (pkg === 'workspace-consumer') {
      return '/repo/packages/workspace-consumer/src/index.ts';
    }
    if (pkg === 'workspace-dual-format') {
      return '/repo/packages/workspace-dual-format/dist/index.js';
    }
    if (pkg === 'workspace-parent-dual-format' && opts?.cwd === '/repo') {
      return '/repo/packages/workspace-parent-dual-format/dist/index.js';
    }
  }),
  getInstalledPackageJson: vi.fn((pkg: string, opts?: { fromResolvedEntry?: string }) => {
    if (opts?.fromResolvedEntry) {
      opts = {
        ...opts,
        fromResolvedEntry: normalizePathForImport(opts.fromResolvedEntry),
      };
    }
    if (opts?.fromResolvedEntry?.includes('/repo/packages/workspace-shared-lib/')) {
      return {
        path: '/repo/packages/workspace-shared-lib/package.json',
        dir: '/repo/packages/workspace-shared-lib',
        packageJson: { name: 'workspace-shared-lib' },
      };
    }
    if (opts?.fromResolvedEntry?.includes('/repo/packages/workspace-unknown-exports/')) {
      return {
        path: '/repo/packages/workspace-unknown-exports/package.json',
        dir: '/repo/packages/workspace-unknown-exports',
        packageJson: { name: 'workspace-unknown-exports' },
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
    if (opts?.fromResolvedEntry?.includes('/repo/packages/workspace-cycle-a/')) {
      return {
        path: '/repo/packages/workspace-cycle-a/package.json',
        dir: '/repo/packages/workspace-cycle-a',
        packageJson: {
          name: 'workspace-cycle-a',
          dependencies: { 'workspace-cycle-b': 'workspace:*' },
        },
      };
    }
    if (opts?.fromResolvedEntry?.includes('/repo/packages/workspace-cycle-b/')) {
      return {
        path: '/repo/packages/workspace-cycle-b/package.json',
        dir: '/repo/packages/workspace-cycle-b',
        packageJson: {
          name: 'workspace-cycle-b',
          dependencies: { 'workspace-cycle-a': 'workspace:*' },
        },
      };
    }
    if (opts?.fromResolvedEntry?.includes('/repo/packages/workspace-producer/')) {
      return {
        path: '/repo/packages/workspace-producer/package.json',
        dir: '/repo/packages/workspace-producer',
        packageJson: { name: 'workspace-producer' },
      };
    }
    if (opts?.fromResolvedEntry?.includes('/repo/packages/workspace-consumer/')) {
      return {
        path: '/repo/packages/workspace-consumer/package.json',
        dir: '/repo/packages/workspace-consumer',
        packageJson: {
          name: 'workspace-consumer',
          dependencies: { 'workspace-producer': 'workspace:*' },
        },
      };
    }
    if (opts?.fromResolvedEntry?.includes('/repo/packages/workspace-dual-format/')) {
      return {
        path: '/repo/packages/workspace-dual-format/package.json',
        dir: '/repo/packages/workspace-dual-format',
        packageJson: {
          name: 'workspace-dual-format',
          exports: {
            '.': {
              import: { default: './dist/index.js' },
              require: { default: './dist/index.cjs' },
            },
          },
        },
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
    if (pkg === 'react-dom') {
      return {
        path: '/repo/apps/remote/node_modules/react-dom/package.json',
        dir: '/repo/apps/remote/node_modules/react-dom',
        packageJson: {
          name: 'react-dom',
          peerDependencies: {
            react: '^19.0.0',
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
  existsSync: vi.fn((filePath: string) => {
    filePath = normalizePathForImport(filePath);
    return (
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
      filePath.endsWith('node_modules/mock-package-enum-destructure/package.json') ||
      filePath.endsWith('/mock-package-enum-destructure/package.json') ||
      filePath.endsWith('node_modules/mock-package-browser-conditional/package.json') ||
      filePath.endsWith('/mock-package-browser-conditional/package.json') ||
      filePath.endsWith('node_modules/mock-package-browser-conditional/dist/browser.js') ||
      filePath.endsWith('/mock-package-browser-conditional/dist/browser.js') ||
      filePath.endsWith('node_modules/mock-package-browser-conditional/dist/server.js') ||
      filePath.endsWith('/mock-package-browser-conditional/dist/server.js') ||
      filePath.endsWith('node_modules/mock-package-dual-shape/dist/browser.js') ||
      filePath.endsWith('/mock-package-dual-shape/dist/browser.js') ||
      filePath.endsWith('node_modules/mock-package-cjs-comment/index.js') ||
      filePath.endsWith('/mock-package-cjs-comment/index.js') ||
      filePath.endsWith('node_modules/react/jsx-runtime.js') ||
      filePath.endsWith('/repo/packages/workspace-shared-lib/package.json') ||
      filePath.endsWith('/repo/packages/workspace-unknown-exports/package.json') ||
      filePath.endsWith('/repo/packages/workspace-unknown-exports/src/index.ts') ||
      filePath.endsWith('/repo/packages/workspace-name-mismatch/package.json') ||
      filePath.endsWith('/repo/packages/workspace-cycle-a/package.json') ||
      filePath.endsWith('/repo/packages/workspace-cycle-b/package.json') ||
      filePath.endsWith('/repo/packages/workspace-producer/package.json') ||
      filePath.endsWith('/repo/packages/workspace-producer/src/index.ts') ||
      filePath.endsWith('/repo/packages/workspace-consumer/package.json') ||
      filePath.endsWith('/repo/packages/workspace-dual-format/package.json') ||
      filePath.endsWith('/repo/packages/workspace-dual-format/dist/index.js') ||
      filePath.endsWith('/repo/packages/mock-package-star-entry.js') ||
      filePath.endsWith('/repo/packages/default-only.js') ||
      filePath.endsWith('/repo/packages/default-only-type-exports.ts') ||
      filePath.endsWith('/repo/packages/default-only-export-lookalikes.js') ||
      filePath.endsWith('/repo/packages/minified-star-export.js') ||
      filePath.endsWith('/repo/packages/comment-separated-star-export.js') ||
      filePath.endsWith('/repo/packages/default-only-cjs-lookalikes.js') ||
      filePath.endsWith('/repo/packages/typescript-cjs-barrel.js') ||
      filePath.endsWith('/repo/packages/babel-cjs-barrel.js') ||
      filePath.endsWith('/repo/packages/default-with-unknown-star.js') ||
      filePath.endsWith('/repo/packages/partial-with-unknown-star.js') ||
      filePath.endsWith('/repo/packages/barrel-with-cjs-star.js') ||
      filePath.endsWith('/repo/packages/hidden.cjs') ||
      filePath.endsWith('/repo/packages/multi-declarator.js') ||
      filePath.endsWith('/repo/packages/postfix-multi-declarator.js') ||
      filePath.endsWith('/repo/packages/string-export-list.js') ||
      filePath.endsWith('/repo/packages/default-reexport-list.js') ||
      filePath.endsWith('/repo/packages/string-namespace-export.js') ||
      filePath.endsWith('/repo/packages/nested-destructuring.js') ||
      filePath.endsWith('/repo/packages/defaulted-destructuring.js') ||
      filePath.endsWith('/repo/packages/typed-destructuring.ts') ||
      filePath.endsWith('/repo/packages/decorated-export.ts') ||
      filePath.endsWith('/repo/packages/export-import-alias.ts') ||
      filePath.endsWith('/repo/packages/custom-shared-source/index.ts')
    );
  }),
  readFileSync: vi.fn((filePath: string) => {
    filePath = normalizePathForImport(filePath);
    if (filePath.endsWith('/repo/packages/mock-package-star-entry.js')) {
      return `// docs: export * from './missing-comment';
const snippet = "export * from './missing-string'";
export * from 'mock-package-star-dependency'; export const directExport = 1;`;
    }
    if (filePath.endsWith('/repo/packages/default-only.js')) {
      return `// docs: export * from './missing-comment';
const snippet = "export const phantom = 1";
const pattern = /export\\s+\\*\\s+from/;
export default function createDefaultOnly() {}`;
    }
    if (filePath.endsWith('/repo/packages/default-only-type-exports.ts')) {
      return `export type { Phantom } from './types';
export interface Shape { value: string }
export declare const declaredOnly: string;
export default function createDefaultOnly() {}`;
    }
    if (filePath.endsWith('/repo/packages/default-only-export-lookalikes.js')) {
      return `// export*from"./comment.js";
const minifiedSnippet = 'export*from"./string.js"';
const separatedSnippet = 'export/* comment */*from"./string.js"';
const markerPattern = /export\\*from/;
export default function createDefaultOnly() {}`;
    }
    if (filePath.endsWith('/repo/packages/minified-star-export.js')) {
      return 'export*from"./dependency.js";';
    }
    if (filePath.endsWith('/repo/packages/comment-separated-star-export.js')) {
      return 'export/* first */*/* second */from/* third */"./dependency.js";';
    }
    if (filePath.endsWith('/repo/packages/default-only-cjs-lookalikes.js')) {
      return `// Object.defineProperty(exports, "__esModule", { value: true });
const typescriptSnippet = "__exportStar(require('./dependency'), exports)";
const babelSnippet = 'Object.defineProperty(exports, "named", descriptor)';
const assignmentSnippet = 'exports = module.exports';
const markerPattern = /exports\\s*(?:[,)]|=(?!=|>))/;
export default function createDefaultOnly() {}`;
    }
    if (filePath.endsWith('/repo/packages/typescript-cjs-barrel.js')) {
      return `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
__exportStar(require("./dependency"), exports);`;
    }
    if (filePath.endsWith('/repo/packages/babel-cjs-barrel.js')) {
      return `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var dependency = require("./dependency");
Object.keys(dependency).forEach(function (key) {
  if (key === "default" || key === "__esModule") return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function () { return dependency[key]; }
  });
});`;
    }
    if (filePath.endsWith('/repo/packages/default-with-unknown-star.js')) {
      return "export default {}; export * from 'unresolved-virtual-module';";
    }
    if (filePath.endsWith('/repo/packages/partial-with-unknown-star.js')) {
      return "export const visible = 1; export * from 'unresolved-virtual-module';";
    }
    if (filePath.endsWith('/repo/packages/barrel-with-cjs-star.js')) {
      return "export const visible = 1; export * from './hidden.cjs';";
    }
    if (filePath.endsWith('/repo/packages/hidden.cjs')) {
      return "module['exports'] = { hidden: 1 };";
    }
    if (filePath.endsWith('/repo/packages/multi-declarator.js')) {
      return `export const first =
  /\\{;/,
  second = 2;`;
    }
    if (filePath.endsWith('/repo/packages/postfix-multi-declarator.js')) {
      return 'export let first = count++ / total, second = /x/;';
    }
    if (filePath.endsWith('/repo/packages/string-export-list.js')) {
      return 'const foo = 1; export { foo as "a-b", foo as valid };';
    }
    if (filePath.endsWith('/repo/packages/default-reexport-list.js')) {
      // MUI's per-component barrel shape: a bare `export { default }` re-export
      // sitting next to real named exports.
      return `export { default } from './Button.mjs';
export { default as buttonClasses } from './buttonClasses.mjs';
export const buttonBase = 1;`;
    }
    if (filePath.endsWith('/repo/packages/string-namespace-export.js')) {
      return `export const visible = 1; export * as "a-b" from './dependency.js';`;
    }
    if (filePath.endsWith('/repo/packages/nested-destructuring.js')) {
      return 'export const visible = 1; export const { nested: { a, b } } = obj;';
    }
    if (filePath.endsWith('/repo/packages/defaulted-destructuring.js')) {
      return 'export const visible = 1; export const { a = fn(1, fake), b } = obj;';
    }
    if (filePath.endsWith('/repo/packages/typed-destructuring.ts')) {
      return 'export const visible = 1; export const { a, b }: Actions = obj;';
    }
    if (filePath.endsWith('/repo/packages/decorated-export.ts')) {
      return 'export const visible = 1; export @dec class Foo {}';
    }
    if (filePath.endsWith('/repo/packages/export-import-alias.ts')) {
      return 'export const visible = 1; export import Alias = Namespace;';
    }
    if (filePath.endsWith('node_modules/mock-package-star-dependency/index.js')) {
      return 'export const fromStar = 1; export function anotherFromStar() {}';
    }
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
      filePath.endsWith('node_modules/mock-package-enum-destructure/package.json') ||
      filePath.endsWith('/mock-package-enum-destructure/package.json')
    ) {
      return JSON.stringify({
        name: 'mock-package-enum-destructure',
        type: 'module',
        module: './src/index.js',
        exports: {
          '.': './src/index.js',
        },
      });
    }
    if (filePath.endsWith('node_modules/mock-package-enum-destructure/src/index.js')) {
      return `export abstract class Base {}
export const enum Direction { Up }
export module LegacyModule {}
export enum Color {
  Red = 'red',
  Blue = 'blue',
}
const actions = { addItem: () => {}, removeItem: () => {}, reset: () => {} };
export const { addItem: createActionAddItem, removeItem: createActionRemoveItem, ...restActions } = actions;
const tuple = [1, 2, 3];
export const [firstItem, ...restItems] = tuple;`;
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
      return '// module.exports = legacy;\nexport const clientOnly = true;';
    }
    if (filePath.endsWith('node_modules/mock-package-browser-conditional/dist/server.js')) {
      return 'export const serverOnly = true;';
    }
    if (filePath.endsWith('node_modules/mock-package-dual-shape/dist/browser.js')) {
      return 'export const browserNamed = true;';
    }
    if (filePath.endsWith('node_modules/mock-package-cjs-comment/index.js')) {
      return "// export const phantom = 1;\nmodule['exports'] = { real: 1 };";
    }
    if (filePath.endsWith('node_modules/react/jsx-runtime.js')) {
      return "module.exports = require('./cjs/react-jsx-runtime.production.min.js');";
    }
    if (filePath.endsWith('/repo/packages/workspace-shared-lib/package.json')) {
      return JSON.stringify({ name: 'workspace-shared-lib' });
    }
    if (filePath.endsWith('/repo/packages/workspace-unknown-exports/package.json')) {
      return JSON.stringify({ name: 'workspace-unknown-exports' });
    }
    if (filePath.endsWith('/repo/packages/workspace-unknown-exports/src/index.ts')) {
      return "export default {}; export * from 'unresolved-workspace-module';";
    }
    if (filePath.endsWith('/repo/packages/workspace-name-mismatch/package.json')) {
      return JSON.stringify({ name: 'different-package-name' });
    }
    if (filePath.endsWith('/repo/packages/workspace-cycle-a/package.json')) {
      return JSON.stringify({
        name: 'workspace-cycle-a',
        dependencies: { 'workspace-cycle-b': 'workspace:*' },
      });
    }
    if (filePath.endsWith('/repo/packages/workspace-cycle-b/package.json')) {
      return JSON.stringify({
        name: 'workspace-cycle-b',
        dependencies: { 'workspace-cycle-a': 'workspace:*' },
      });
    }
    if (filePath.endsWith('/repo/packages/workspace-producer/src/index.ts')) {
      return 'export const useProducer = () => 1; export function createProducer() {}';
    }
    if (filePath.endsWith('/repo/packages/workspace-dual-format/package.json')) {
      return JSON.stringify({
        name: 'workspace-dual-format',
        exports: {
          '.': {
            import: { default: './dist/index.js' },
            require: { default: './dist/index.cjs' },
          },
        },
      });
    }
    if (filePath.endsWith('/repo/packages/workspace-dual-format/dist/index.js')) {
      return 'export const sharedValue = 42; export function increment() { return sharedValue + 1; }';
    }
    if (filePath.endsWith('/repo/packages/custom-shared-source/index.ts')) {
      return `export const sharedValue = 'shared';
              export function useSharedFeature() {
                return sharedValue;
              }`;
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
  statSync: vi.fn(() => ({
    isDirectory: () => false,
  })),
}));

// Mock module/createRequire to return specific named exports
vi.mock('module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('module')>();
  return {
    ...actual,
    createRequire: (from: string | URL) => {
      const fromPath = String(from);
      const req = ((pkg: string) => {
        if (pkg === 'mock-package-with-reserved') {
          return {
            delete: 1,
            get: 2,
            request: 3,
            default: 4,
            __esModule: true,
          };
        }
        if (pkg === 'mock-package-js-keywords') {
          return {
            class: 1,
            function: 2,
            await: 3,
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
        if (pkg === 'mock-package-string-export') {
          return {
            'foo-bar': 1,
            default: {},
            __esModule: true,
          };
        }
        if (pkg.endsWith('/mock-package-cjs-comment/index.js')) {
          return {
            real: 1,
            default: {},
            __esModule: true,
          };
        }
        if (pkg.endsWith('/react/jsx-runtime.js')) {
          return {
            Fragment: Symbol.for('react.fragment'),
            jsx: () => undefined,
            jsxs: () => undefined,
          };
        }
        if (pkg.endsWith('/typescript-cjs-barrel.js')) {
          return {
            typescriptNamed: 1,
            default: {},
            __esModule: true,
          };
        }
        if (pkg.endsWith('/babel-cjs-barrel.js')) {
          return {
            babelNamed: 1,
            default: {},
            __esModule: true,
          };
        }
        if (pkg.endsWith('/default-only-cjs-lookalikes.js')) {
          const error = new Error('ERR_REQUIRE_ESM');
          (error as Error & { code?: string }).code = 'ERR_REQUIRE_ESM';
          throw error;
        }
        if (pkg === 'workspace-producer') {
          return {
            useProducer: () => 1,
            createProducer: () => ({}),
            default: {},
            __esModule: true,
          };
        }
        if (pkg === 'transitive-pkg') {
          throw new Error('MODULE_NOT_FOUND');
        }
        if (pkg === 'host-only-dep') {
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
          pkg === 'mock-package-enum-destructure' ||
          pkg.startsWith('mock-package-enum-destructure/')
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
          if (pkg === 'workspace-parent-dual-format') {
            if (!fromPath.includes('/repo/package.json')) {
              throw new Error('MODULE_NOT_FOUND');
            }
            return '/repo/packages/workspace-parent-dual-format/dist/index.cjs';
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
          if (pkg === 'workspace-unknown-exports') {
            return '/repo/packages/workspace-unknown-exports/src/index.ts';
          }
          if (pkg === 'workspace-esm-symlink') {
            const error = new Error('ERR_PACKAGE_PATH_NOT_EXPORTED');
            (error as Error & { code?: string }).code = 'ERR_PACKAGE_PATH_NOT_EXPORTED';
            throw error;
          }
          if (pkg === 'workspace-name-mismatch') {
            return '/repo/packages/workspace-name-mismatch/src/index.ts';
          }
          if (pkg === 'workspace-cycle-a') {
            return '/repo/packages/workspace-cycle-a/src/index.ts';
          }
          if (pkg === 'workspace-cycle-b') {
            return '/repo/packages/workspace-cycle-b/src/index.ts';
          }
          if (pkg === 'workspace-producer' || pkg.startsWith('workspace-producer/')) {
            return '/repo/packages/workspace-producer/src/index.ts';
          }
          if (pkg === 'workspace-consumer') {
            return '/repo/packages/workspace-consumer/src/index.ts';
          }
          if (pkg === 'workspace-dual-format') {
            return '/repo/packages/workspace-dual-format/dist/index.cjs';
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
    setTreeShakingBuildMode(false);
    writeSyncSpy.mockClear();
    mfWarnSpy.mockClear();
    hasPackageDependencyMock.mockReset();
    hasPackageDependencyMock.mockReturnValue(false);
    normalizeModuleFederationOptions({ name: 'test' });
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

    expectLiveSingletonProxy(generatedCode, pkg, ['delete', 'get', 'request']);
  });

  it('uses live exported bindings for eager singleton proxies with known named exports', () => {
    const pkg = 'mock-package-browser-conditional';
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
    const cacheDescriptor =
      '{"canonical":"default:mock-package-browser-conditional","aliases":["mock-package-browser-conditional"]}';

    expect(generatedCode).toContain('let __mfDefaultExport;');
    expect(generatedCode).toContain('let __mf_0;');
    expect(generatedCode).toContain('const __mfApplySharedExports = (mod) => {');
    expect(generatedCode).toContain('__mf_0 = mod["clientOnly"];');
    expect(generatedCode).toContain(
      `__mfSubscribeSharedCache(__mfModuleCache.share, ${cacheDescriptor}, __mfApplySharedExports);`
    );
    expect(generatedCode).toContain('__mfApplySharedExports(exportModule);');
    expect(generatedCode).toContain('export { __mfDefaultExport as default };');
    expect(generatedCode).toContain('export { __mf_0 as clientOnly };');
    expect(generatedCode).not.toContain('const { clientOnly: __mf_0 } = exportModule;');
  });

  it('aliases reserved named exports in prebuild wrappers instead of declaring them', () => {
    writePreBuildLibPath('mock-package-with-reserved');

    expect(writeSyncSpy).toHaveBeenCalled();
    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).not.toContain('export const delete');
    expect(generatedCode).toContain('const __mf_0 = __mfPrebuildExports["delete"];');
    expect(generatedCode).toContain('const __mf_1 = __mfPrebuildExports["get"];');
    expect(generatedCode).toContain('const __mf_2 = __mfPrebuildExports["request"];');
    expect(generatedCode).toContain(
      'export { __mf_0 as delete, __mf_1 as get, __mf_2 as request };'
    );
  });

  it('aliases JavaScript keyword named exports in prebuild wrappers', () => {
    writePreBuildLibPath('mock-package-js-keywords');

    expect(writeSyncSpy).toHaveBeenCalled();
    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).not.toContain('export const class');
    expect(generatedCode).not.toContain('export const function');
    expect(generatedCode).not.toContain('export const await');
    expect(generatedCode).toContain('const __mf_0 = __mfPrebuildExports["class"];');
    expect(generatedCode).toContain('const __mf_1 = __mfPrebuildExports["function"];');
    expect(generatedCode).toContain('const __mf_2 = __mfPrebuildExports["await"];');
    expect(generatedCode).toContain(
      'export { __mf_0 as class, __mf_1 as function, __mf_2 as await };'
    );
  });

  it('keeps an uninspectable configured prebuild source authoritative', () => {
    const mockShareItem: ShareItem = {
      name: 'mock-package-with-reserved',
      from: '',
      version: '1.0.0',
      shareConfig: {
        import: '/abs/mock-package-with-reserved/index.js',
        singleton: true,
        strictVersion: false,
        requiredVersion: '^1.0.0',
      },
      scope: 'default',
    };

    writePreBuildLibPath('mock-package-with-reserved', mockShareItem);

    expect(writeSyncSpy).toHaveBeenCalled();
    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain(
      'import * as __mfPrebuildExports from "/abs/mock-package-with-reserved/index.js";'
    );
    expect(generatedCode).toContain('export * from "/abs/mock-package-with-reserved/index.js";');
    expect(generatedCode).not.toContain('__mfPrebuildNamespace');
    expect(generatedCode).not.toContain('__mf_0 as delete');
  });

  it('detects prebuild named exports from shareConfig.import when it points at a non-package module', () => {
    const pkg = '@repo/custom-shared-source';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '1.0.0',
      shareConfig: {
        import: '/repo/packages/custom-shared-source',
        singleton: true,
        strictVersion: false,
        requiredVersion: '^1.0.0',
      },
      scope: 'default',
    };

    writePreBuildLibPath(pkg, mockShareItem);

    expect(writeSyncSpy).toHaveBeenCalled();
    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain(
      'import * as __mfPrebuildNamespace from "/repo/packages/custom-shared-source";'
    );
    expect(generatedCode).toContain('const __mf_0 = __mfPrebuildExports["sharedValue"];');
    expect(generatedCode).toContain('const __mf_1 = __mfPrebuildExports["useSharedFeature"];');
    expect(generatedCode).toContain(
      'export { __mf_0 as sharedValue, __mf_1 as useSharedFeature };'
    );
    expect(generatedCode).not.toContain('export * from "/repo/packages/custom-shared-source"');
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
    expect(generatedCode).toContain(
      '__mfReadSharedCache(__mfModuleCache.share, {"canonical":"default:mock-package-with-reserved","aliases":["mock-package-with-reserved"]})'
    );
    expect(generatedCode).not.toContain('await ');
    expect(generatedCode).not.toContain('import { initPromise } from');
    expect(generatedCode).not.toContain('require("mock-import-id")');
  });

  it('keys non-singleton shared cache by version so incompatible versions can coexist', () => {
    const pkg = 'zustand';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '4.5.7',
      shareConfig: {
        singleton: false,
        strictVersion: false,
        requiredVersion: '^4.5.5',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).not.toContain('"canonical":"default:zustand","aliases":["zustand"]');
    expect(generatedCode).toContain('"canonical":"default:zustand@4.5.7"');
    expect(generatedCode).toContain('"aliases":["zustand@4.5.7"]');
  });

  it('uses shared cache compatibility helpers in loadShare modules', () => {
    const pkg = 'react';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '19.2.7',
      shareConfig: {
        singleton: true,
        strictVersion: false,
        requiredVersion: '^19.2.7',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain('const __mfGetSharedCacheDescriptor =');
    expect(generatedCode).toContain(
      '__mfReadSharedCache(__mfModuleCache.share, {"canonical":"default:react","aliases":["react"]})'
    );
    expect(generatedCode).toContain(
      '__mfWriteSharedCache(__mfModuleCache.share, {"canonical":"default:react","aliases":["react"]}, exportModule, "test")'
    );
    expect(generatedCode).not.toContain(
      'let exportModule = __mfModuleCache.share["default:react"]'
    );
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

    expectLiveSingletonProxy(generatedCode, pkg, ['delete', 'get', 'request']);
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

  it('detects loadShare named exports from shareConfig.import when it points at a non-package module', () => {
    const pkg = '@repo/custom-shared-source';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '1.0.0',
      shareConfig: {
        import: '/repo/packages/custom-shared-source',
        singleton: true,
        strictVersion: false,
        requiredVersion: '^1.0.0',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain(
      'import * as __mfLocalShare from "/repo/packages/custom-shared-source";'
    );
    expectLiveSingletonProxy(generatedCode, pkg, ['sharedValue', 'useSharedFeature']);
    expect(generatedCode).not.toContain('export * from "/repo/packages/custom-shared-source"');
    expect(generatedCode).not.toContain('mock-import-id');
  });

  it('detects named exports from package star re-exports in shareConfig.import', () => {
    const pkg = 'mock-package-star-entry';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '1.0.0',
      shareConfig: {
        import: '/repo/packages/mock-package-star-entry.js',
        singleton: true,
        strictVersion: false,
        requiredVersion: '^1.0.0',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expectLiveSingletonProxy(generatedCode, pkg, ['directExport', 'fromStar', 'anotherFromStar']);
  });

  it('keeps an uninspectable configured singleton proxy on one local module', () => {
    const pkg = 'mock-package-with-reserved';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '1.0.0',
      shareConfig: {
        import: '/missing/mock-package-with-reserved/index.js',
        singleton: true,
        strictVersion: false,
        requiredVersion: '^1.0.0',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain(
      'import * as __mfLocalShare from "/missing/mock-package-with-reserved/index.js";'
    );
    expect(generatedCode).toContain('let current = __mfLocalShare;');
    expect(generatedCode).toContain('export default __mfDefaultExport;');
    expect(generatedCode).toContain('export * from "/missing/mock-package-with-reserved/index.js"');
    expect(generatedCode).not.toContain('__mfSubscribeSharedCache(__mfModuleCache.share');
    expect(generatedCode).not.toContain('__mfApplySharedExports');
    expect(generatedCode).not.toContain('__mf_0 as delete');
  });

  it('keeps a complete default-only ESM singleton live across cache replacement', () => {
    const pkg = 'mock-package-with-reserved';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '1.0.0',
      shareConfig: {
        import: '/repo/packages/default-only.js',
        singleton: true,
        strictVersion: false,
        requiredVersion: '^1.0.0',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain('const __mfApplySharedDefaultExport = (mod) => {');
    expect(generatedCode).toContain('__mfApplySharedDefaultExport(exportModule);');
    expect(generatedCode).toContain('export { __mfDefaultExport as default };');
    expect(generatedCode).toContain('export * from "/repo/packages/default-only.js"');
    expect(generatedCode).not.toContain('let current = __mfLocalShare;');
    expect(generatedCode).not.toContain('phantom');
  });

  it('ignores erased TypeScript exports when determining live proxy coverage', () => {
    const pkg = 'mock-package-with-reserved';
    const importPath = '/repo/packages/default-only-type-exports.ts';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '1.0.0',
      shareConfig: {
        import: importPath,
        singleton: true,
        strictVersion: false,
        requiredVersion: '^1.0.0',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain('const __mfApplySharedDefaultExport = (mod) => {');
    expect(generatedCode).toContain(`export * from ${JSON.stringify(importPath)}`);
    expect(generatedCode).not.toContain('let current = __mfLocalShare;');
    expect(generatedCode).not.toContain('Phantom');
    expect(generatedCode).not.toContain('declaredOnly');
  });

  it.each([
    ['minified', '/repo/packages/minified-star-export.js'],
    ['comment-separated', '/repo/packages/comment-separated-star-export.js'],
  ])('treats an unrecognized %s export declaration as unknown coverage', (_syntax, importPath) => {
    const pkg = 'mock-package-with-reserved';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '1.0.0',
      shareConfig: {
        import: importPath,
        singleton: true,
        strictVersion: false,
        requiredVersion: '^1.0.0',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain('let current = __mfLocalShare;');
    expect(generatedCode).toContain(`export * from ${JSON.stringify(importPath)}`);
    expect(generatedCode).not.toContain('__mfApplySharedDefaultExport');
    expect(generatedCode).not.toContain('__mfSubscribeSharedCache(__mfModuleCache.share');
  });

  it('ignores unmatched export syntax in comments, strings, and regular expressions', () => {
    const pkg = 'mock-package-with-reserved';
    const importPath = '/repo/packages/default-only-export-lookalikes.js';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '1.0.0',
      shareConfig: {
        import: importPath,
        singleton: true,
        strictVersion: false,
        requiredVersion: '^1.0.0',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain('const __mfApplySharedDefaultExport = (mod) => {');
    expect(generatedCode).toContain(`export * from ${JSON.stringify(importPath)}`);
    expect(generatedCode).not.toContain('let current = __mfLocalShare;');
  });

  it.each([
    ['TypeScript', '/repo/packages/typescript-cjs-barrel.js', 'typescriptNamed'],
    ['Babel', '/repo/packages/babel-cjs-barrel.js', 'babelNamed'],
  ])('uses runtime keys for %s-transpiled CommonJS barrels', (_transpiler, importPath, name) => {
    const pkg = 'mock-package-with-reserved';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '1.0.0',
      shareConfig: {
        import: importPath,
        singleton: true,
        strictVersion: false,
        requiredVersion: '^1.0.0',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expectLiveSingletonProxy(generatedCode, pkg, [name]);
    expect(generatedCode).not.toContain(`export * from ${JSON.stringify(importPath)}`);
  });

  it('ignores CommonJS export markers in comments, strings, and regular expressions', () => {
    const pkg = 'mock-package-with-reserved';
    const importPath = '/repo/packages/default-only-cjs-lookalikes.js';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '1.0.0',
      shareConfig: {
        import: importPath,
        singleton: true,
        strictVersion: false,
        requiredVersion: '^1.0.0',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain('const __mfApplySharedDefaultExport = (mod) => {');
    expect(generatedCode).toContain(`export * from ${JSON.stringify(importPath)}`);
    expect(generatedCode).not.toContain('let current = __mfLocalShare;');
  });

  it('does not treat a default export with unresolved star exports as complete', () => {
    const pkg = 'mock-package-with-reserved';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '1.0.0',
      shareConfig: {
        import: '/repo/packages/default-with-unknown-star.js',
        singleton: true,
        strictVersion: false,
        requiredVersion: '^1.0.0',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain('let current = __mfLocalShare;');
    expect(generatedCode).toContain('export * from "/repo/packages/default-with-unknown-star.js"');
    expect(generatedCode).not.toContain('__mfSubscribeSharedCache(__mfModuleCache.share');
    expect(generatedCode).not.toContain('__mfApplySharedDefaultExport');
  });

  it('does not treat partial exports with an unresolved star as complete', () => {
    const pkg = 'mock-package-with-reserved';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '1.0.0',
      shareConfig: {
        import: '/repo/packages/partial-with-unknown-star.js',
        singleton: true,
        strictVersion: false,
        requiredVersion: '^1.0.0',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain('let current = __mfLocalShare;');
    expect(generatedCode).toContain('export * from "/repo/packages/partial-with-unknown-star.js"');
    expect(generatedCode).not.toContain('__mfApplySharedExports');
    expect(generatedCode).not.toContain('__mf_0 as visible');
  });

  it('does not treat an ESM barrel over CommonJS as complete', () => {
    const pkg = 'mock-package-with-reserved';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '1.0.0',
      shareConfig: {
        import: '/repo/packages/barrel-with-cjs-star.js',
        singleton: true,
        strictVersion: false,
        requiredVersion: '^1.0.0',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain('let current = __mfLocalShare;');
    expect(generatedCode).toContain('export * from "/repo/packages/barrel-with-cjs-star.js"');
    expect(generatedCode).not.toContain('__mfApplySharedExports');
  });

  it('does not treat multi-declarator exports as complete', () => {
    const pkg = 'mock-package-with-reserved';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '1.0.0',
      shareConfig: {
        import: '/repo/packages/multi-declarator.js',
        singleton: true,
        strictVersion: false,
        requiredVersion: '^1.0.0',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain('let current = __mfLocalShare;');
    expect(generatedCode).toContain('export * from "/repo/packages/multi-declarator.js"');
    expect(generatedCode).not.toContain('__mfApplySharedExports');
    expect(generatedCode).not.toContain('__mf_0 as first');
  });

  it('detects multi-declarators after postfix division expressions', () => {
    const pkg = 'mock-package-with-reserved';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '1.0.0',
      shareConfig: {
        import: '/repo/packages/postfix-multi-declarator.js',
        singleton: true,
        strictVersion: false,
        requiredVersion: '^1.0.0',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain('export * from "/repo/packages/postfix-multi-declarator.js"');
    expect(generatedCode).not.toContain('__mfApplySharedExports');
    expect(generatedCode).not.toContain('__mf_0 as first');
  });

  it('does not treat string-named export lists as complete', () => {
    const pkg = 'mock-package-with-reserved';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '1.0.0',
      shareConfig: {
        import: '/repo/packages/string-export-list.js',
        singleton: true,
        strictVersion: false,
        requiredVersion: '^1.0.0',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain('export * from "/repo/packages/string-export-list.js"');
    expect(generatedCode).not.toContain('__mfApplySharedExports');
    expect(generatedCode).not.toContain('__mf_0 as valid');
  });

  it('keeps named exports alongside a bare default re-export as complete', () => {
    const pkg = 'mock-package-with-reserved';
    const importPath = '/repo/packages/default-reexport-list.js';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '1.0.0',
      shareConfig: {
        import: importPath,
        singleton: true,
        strictVersion: false,
        requiredVersion: '^1.0.0',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    // Regression (#918): `export { default } from './x'` must not abort the scan.
    // buttonBase (declaration) + buttonClasses (`as` alias) are detected; the bare
    // `default` is skipped rather than marking the scan incomplete.
    expectLiveSingletonProxy(generatedCode, pkg, ['buttonBase', 'buttonClasses']);
    expect(generatedCode).not.toContain(`export * from ${JSON.stringify(importPath)}`);
  });

  it('does not treat string-named namespace exports as complete', () => {
    const pkg = 'mock-package-with-reserved';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '1.0.0',
      shareConfig: {
        import: '/repo/packages/string-namespace-export.js',
        singleton: true,
        strictVersion: false,
        requiredVersion: '^1.0.0',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain('export * from "/repo/packages/string-namespace-export.js"');
    expect(generatedCode).not.toContain('__mfApplySharedExports');
    expect(generatedCode).not.toContain('__mf_0 as visible');
  });

  it('does not treat nested destructuring exports as complete', () => {
    const pkg = 'mock-package-with-reserved';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '1.0.0',
      shareConfig: {
        import: '/repo/packages/nested-destructuring.js',
        singleton: true,
        strictVersion: false,
        requiredVersion: '^1.0.0',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain('export * from "/repo/packages/nested-destructuring.js"');
    expect(generatedCode).not.toContain('__mfApplySharedExports');
    expect(generatedCode).not.toContain('__mf_0 as visible');
  });

  it('does not infer bogus exports from defaulted destructuring expressions', () => {
    const pkg = 'mock-package-with-reserved';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '1.0.0',
      shareConfig: {
        import: '/repo/packages/defaulted-destructuring.js',
        singleton: true,
        strictVersion: false,
        requiredVersion: '^1.0.0',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain('export * from "/repo/packages/defaulted-destructuring.js"');
    expect(generatedCode).not.toContain('__mfApplySharedExports');
    expect(generatedCode).not.toContain('__mf_0 as visible');
    expect(generatedCode).not.toContain('as fake');
  });

  it('does not treat typed destructuring exports as complete', () => {
    const pkg = 'mock-package-with-reserved';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '1.0.0',
      shareConfig: {
        import: '/repo/packages/typed-destructuring.ts',
        singleton: true,
        strictVersion: false,
        requiredVersion: '^1.0.0',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain('export * from "/repo/packages/typed-destructuring.ts"');
    expect(generatedCode).not.toContain('__mfApplySharedExports');
    expect(generatedCode).not.toContain('__mf_0 as visible');
  });

  it('does not treat decorated exports as complete', () => {
    const pkg = 'mock-package-with-reserved';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '1.0.0',
      shareConfig: {
        import: '/repo/packages/decorated-export.ts',
        singleton: true,
        strictVersion: false,
        requiredVersion: '^1.0.0',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain('export * from "/repo/packages/decorated-export.ts"');
    expect(generatedCode).not.toContain('__mfApplySharedExports');
    expect(generatedCode).not.toContain('__mf_0 as visible');
  });

  it('treats TypeScript export-import aliases as unknown coverage', () => {
    const pkg = 'mock-package-with-reserved';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '1.0.0',
      shareConfig: {
        import: '/repo/packages/export-import-alias.ts',
        singleton: true,
        strictVersion: false,
        requiredVersion: '^1.0.0',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain('let current = __mfLocalShare;');
    expect(generatedCode).not.toContain('__mfApplySharedExports');
    expect(generatedCode).not.toContain('__mf_0 as visible');
  });

  it('keeps unknown configured exports local in remote-only serve mode', () => {
    normalizeModuleFederationOptions({
      name: 'remote',
      exposes: { './App': './src/App.ts' },
    });
    const pkg = 'mock-package-with-reserved';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '1.0.0',
      shareConfig: {
        import: '/missing/virtual-shared-module.js',
        singleton: true,
        strictVersion: false,
        requiredVersion: '^1.0.0',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'serve', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain(
      'import * as __mfLocalShare from "/missing/virtual-shared-module.js";'
    );
    expect(generatedCode).toContain('let current = __mfLocalShare;');
    expect(generatedCode).toContain('export * from "/missing/virtual-shared-module.js"');
    expect(generatedCode).not.toContain('__mfApplyLazyShareExports');
    expect(generatedCode).not.toContain('pendingShareLoads');
  });

  it('statically imports unknown workspace exports in serve mode', () => {
    normalizeModuleFederationOptions({
      name: 'remote',
      exposes: { './App': './src/App.ts' },
    });
    const pkg = 'workspace-unknown-exports';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '1.0.0',
      shareConfig: {
        import: '/repo/packages/workspace-unknown-exports/src/index.ts',
        singleton: true,
        strictVersion: false,
        requiredVersion: '^1.0.0',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'serve', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain(
      'import * as __mfLocalShare from "/repo/packages/workspace-unknown-exports/src/index.ts";'
    );
    expect(generatedCode).toContain('let current = __mfLocalShare;');
    expect(generatedCode).not.toContain('__mfApplyLazyShareExports');
  });

  it('uses a direct local source for unknown workspace exports in build mode', () => {
    const pkg = 'workspace-unknown-exports';
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
    const localSource = '/repo/packages/workspace-unknown-exports/src/index.ts';

    expect(generatedCode).toContain(`import * as __mfLocalShare from "${localSource}";`);
    expect(generatedCode).toContain(`export * from "${localSource}"`);
    expect(generatedCode).not.toContain('__prebuild__');
    expect(generatedCode).not.toContain('__mfApplySharedExports');
  });

  it('treats unsupported runtime export names as unknown coverage', () => {
    const pkg = 'mock-package-string-export';
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

    expect(generatedCode).toContain('let current = __mfLocalShare;');
    expect(generatedCode).toContain('export * from "/resolved/mock-package-string-export"');
    expect(generatedCode).not.toContain('__prebuild__');
    expect(generatedCode).not.toContain('__mfApplySharedDefaultExport');
  });

  it('detects named exports from the ESM entry of configured bare import sources', () => {
    const pkg = 'mock-package-browser-conditional';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '1.0.0',
      shareConfig: {
        import: pkg,
        singleton: true,
        strictVersion: false,
        requiredVersion: '^1.0.0',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'build', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain(
      'import * as __mfLocalShare from "mock-package-browser-conditional";'
    );
    expectLiveSingletonProxy(generatedCode, pkg, ['clientOnly']);
    expect(generatedCode).not.toContain('serverOnly');
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

    expect(generatedCode).toContain(
      '__mfReadSharedCache(__mfModuleCache.share, {"canonical":"default:react","aliases":["react"]})'
    );
    expect(generatedCode).not.toContain('providerModulePromise');
    expect(generatedCode).not.toContain('await ');
  });

  it('generates React 17 JSX runtime exports from the legacy subpath entry', () => {
    const pkg = 'react/jsx-runtime';
    const mockShareItem: ShareItem = {
      name: 'react',
      from: '',
      version: '17.0.2',
      shareConfig: {
        singleton: true,
        strictVersion: false,
        requiredVersion: '^17.0.2',
      },
      scope: 'default',
    };

    writeLoadShareModule(pkg, mockShareItem, 'build', true);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expectLiveSingletonProxy(generatedCode, pkg, ['Fragment', 'jsx', 'jsxs']);
    expect(generatedCode).not.toContain('createElement');
    expect(generatedCode).not.toContain('useState');
  });

  it('reads React compiler runtime internals from the compatible React cache key', () => {
    const pkg = 'react/compiler-runtime';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '19.2.7',
      shareConfig: {
        singleton: true,
        strictVersion: false,
        requiredVersion: '^19.2.7',
      },
      scope: 'default',
    };

    writePreBuildLibPath(pkg, mockShareItem);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain('const __mfGetSharedCacheDescriptor =');
    expect(generatedCode).toContain(
      '__mfReadSharedCache(cache, {"canonical":"default:react","aliases":["react"]})'
    );
    expect(generatedCode).not.toContain("cache?.['react']");
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

    expectLiveSingletonProxy(generatedCode, pkg, ['useCounter', 'useLogger']);
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

    expectLiveSingletonProxy(generatedCode, pkg, ['ångstrom', 'café']);
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
    expect(generatedCode).toContain(
      '__mfReadSharedCache(__mfModuleCache.share, {"canonical":"default:host-only-dep","aliases":["host-only-dep"]})'
    );
    expect(generatedCode).toContain('export { __mf_default as default }');
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
    expect(generatedCode).toContain(
      '__mfReadSharedCache(__mfModuleCache.share, {"canonical":"default:host-only-dep","aliases":["host-only-dep"]})'
    );
    expect(generatedCode).not.toContain('await ');
    expect(generatedCode).toContain('initPromise.then');
    expect(generatedCode).toContain('export { __mf_default as default }');
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
    expect(generatedCode).toContain(
      '__mfReadSharedCache(__mfModuleCache.share, {"canonical":"default:mock-package-with-reserved","aliases":["mock-package-with-reserved"]})'
    );
    // Should have named exports destructured from the runtime-provided module
    expect(generatedCode).toContain('__mf_0 as delete');
    expect(generatedCode).toContain('__mf_1 as get');
    expect(generatedCode).toContain('__mf_2 as request');
    expect(generatedCode).toContain('export { __mf_default as default }');
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

  it('uses the Vite import entry when the require condition has a different shape', () => {
    const pkg = 'mock-package-dual-shape';
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

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain('__mf_0 as browserNamed');
    expect(mfWarnSpy).not.toHaveBeenCalled();
  });

  it('uses CommonJS runtime keys instead of comment-like ESM syntax', () => {
    const pkg = 'mock-package-cjs-comment';
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

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain('__mf_0 as real');
    expect(generatedCode).not.toContain('phantom');
    expect(mfWarnSpy).not.toHaveBeenCalled();
  });

  it('prefers browser conditional exports for project-resolved import paths', () => {
    expect(getProjectResolvedImportPath('mock-package-browser-conditional')).toBe(
      '/repo/apps/remote/node_modules/mock-package-browser-conditional/dist/browser.js'
    );
  });

  it('uses parent-root cwd when resolving workspace ESM entries', () => {
    expect(getConcreteSharedImportSource('workspace-parent-dual-format')).toBe(
      '/repo/packages/workspace-parent-dual-format/dist/index.js'
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
    expect(generatedCode).not.toContain('__mf_0 as');
    // Only default export
    expect(generatedCode).toContain('export { __mf_default as default }');
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

    expect(generatedCode).toContain('__mf_0 = exportModule["SharedCounter2"];');
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

    expect(generatedCode).toContain('__mf_0 = exportModule["type"];');
    expect(generatedCode).toContain('__mf_1 = exportModule["other"];');
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

    expect(generatedCode).toContain('__mf_0 = exportModule["type"];');
    expect(generatedCode).toContain('__mf_1 = exportModule["other"];');
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

    expect(generatedCode).toContain('__mf_0 = exportModule["loader"];');
    expect(generatedCode).toContain('export { __mf_0 as loader };');
  });

  it('detects enum and destructuring exports via regex fallback', () => {
    const pkg = 'mock-package-enum-destructure';
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

    // `export enum Color` is a runtime value and must be re-exported.
    expect(generatedCode).toContain('exportModule["Color"]');
    expect(generatedCode).toContain('as Color');
    expect(generatedCode).toContain('exportModule["Base"]');
    expect(generatedCode).toContain('as Base');
    expect(generatedCode).toContain('exportModule["Direction"]');
    expect(generatedCode).toContain('as Direction');
    expect(generatedCode).toContain('exportModule["LegacyModule"]');
    expect(generatedCode).toContain('as LegacyModule');
    expect(generatedCode).not.toContain('as enum');
    // Destructuring exports (e.g. createSlice actions) keep their bound names.
    expect(generatedCode).toContain('exportModule["createActionAddItem"]');
    expect(generatedCode).toContain('as createActionAddItem');
    expect(generatedCode).toContain('exportModule["createActionRemoveItem"]');
    expect(generatedCode).toContain('as createActionRemoveItem');
    // Rest elements bind a real value and must be re-exported too.
    expect(generatedCode).toContain('exportModule["restActions"]');
    expect(generatedCode).toContain('as restActions');
    // Array destructuring, including its rest element.
    expect(generatedCode).toContain('exportModule["firstItem"]');
    expect(generatedCode).toContain('as firstItem');
    expect(generatedCode).toContain('exportModule["restItems"]');
    expect(generatedCode).toContain('as restItems');
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

  it('uses sync local fallback in build mode for SSR and lazy init on client', () => {
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

    expect(generatedCode).not.toContain('import * as __mfLocalShare');
    expect(generatedCode).toContain('if (import.meta.env.SSR) {');
    expect(generatedCode).toContain('__mfNormalizeShareModule(__mfLocalShare)');
    expect(generatedCode).toContain(
      'import("/repo/packages/workspace-shared-lib/src/index.tsx").then((mod) => {'
    );
    expect(generatedCode).toContain('initPromise.then');
    expect(generatedCode).not.toContain('await ');
    expect(generatedCode.match(/let exportModule/g)?.length ?? 0).toBe(1);
    expect(generatedCode).toContain('let __mf_default;');
    expect(generatedCode).toContain('const __mfApplyLazyShareExports = (mod) => {');
    expect(generatedCode).toContain('__mf_default = mod.default ?? mod;');
    expect(generatedCode).toContain(
      '__mfSubscribeSharedCache(__mfModuleCache.share, {"canonical":"default:workspace-shared-lib","aliases":["workspace-shared-lib"]}, __mfApplyLazyShareExports);'
    );
    expect(generatedCode).toContain('export { __mf_default as default };');
  });

  it('prepends workspace singleton static import for SSR build loads only', async () => {
    const { prependWorkspaceSingletonSsrImport } = await import('../virtualShared_preBuild');
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

    expect(generatedCode).not.toContain('import * as __mfLocalShare');
    const ssrCode = prependWorkspaceSingletonSsrImport(generatedCode);
    expect(ssrCode).toContain(
      'import * as __mfLocalShare from "/repo/packages/workspace-shared-lib/src/index.tsx";'
    );
    expect(prependWorkspaceSingletonSsrImport(ssrCode)).toBe(ssrCode);

    const duplicateImport = `${ssrCode}\nimport * as __mfLocalShare from "/repo/packages/workspace-shared-lib/src/index.tsx";`;
    const deduped = prependWorkspaceSingletonSsrImport(duplicateImport);
    expect(deduped.match(/import \* as __mfLocalShare/g)).toHaveLength(1);
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
    expect(generatedCode).toContain('if (import.meta.env.SSR) {');
    expect(generatedCode).toContain('__mfNormalizeShareModule(__mfLocalShare)');
    expect(generatedCode).not.toContain('export * from');
    expect(generatedCode).toContain(
      'import("/repo/apps/remote/node_modules/workspace-esm-symlink/src/index.ts").then((mod) => {'
    );
    expect(generatedCode).not.toContain('await ');
  });

  it('emits live local re-exports for cyclic workspace singletons in build mode', () => {
    normalizeModuleFederationOptions({
      name: 'host',
      shared: {
        'workspace-cycle-a': { singleton: true },
        'workspace-cycle-b': { singleton: true },
      },
    });
    const pkg = 'workspace-cycle-a';
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
      'import * as __mfLocalShare from "/repo/packages/workspace-cycle-a/src/index.ts";'
    );
    expect(generatedCode).toContain('export { __mf_default as default };');
    expect(generatedCode).toContain('let __mf_default;');
    expect(generatedCode).toContain('const __mfApplyEagerShareExports = (mod) => {');
    expect(generatedCode).toContain('__mf_default = mod.default ?? mod;');
    expect(generatedCode).toContain(
      '__mfSubscribeSharedCache(__mfModuleCache.share, {"canonical":"default:workspace-cycle-a","aliases":["workspace-cycle-a"]}, __mfApplyEagerShareExports);'
    );
    expect(generatedCode).toContain('__mfApplyEagerShareExports(exportModule);');
    expect(generatedCode).not.toContain('initPromise.then');
    expect(generatedCode).not.toContain('await ');
    expect(generatedCode).toContain('Promise.resolve().then');
  });

  it('emits eager local re-exports for acyclic workspace singletons consumed by a peer', () => {
    // Reproduces issue #823: an acyclic (DAG) shared-singleton graph where
    // `workspace-producer` is shared together with one of its subpath exports and
    // is depended on by a peer shared singleton (`workspace-consumer`). The peer
    // reads the producer's bindings at module-evaluation time, so the producer must
    // assign its exports synchronously. Before the fix only cyclic graphs triggered
    // the eager path, leaving this case lazy and crashing at startup with
    // "Cannot read properties of undefined".
    normalizeModuleFederationOptions({
      name: 'host',
      shared: {
        'workspace-producer': { singleton: true },
        'workspace-producer/extra': { singleton: true },
        'workspace-consumer': { singleton: true },
      },
    });
    const pkg = 'workspace-producer';
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
      'import * as __mfLocalShare from "/repo/packages/workspace-producer/src/index.ts";'
    );
    expect(generatedCode.match(/import \* as __mfLocalShare/g)).toHaveLength(1);
    expect(generatedCode).toContain('export { __mf_default as default };');
    expect(generatedCode).toContain('let __mf_default;');
    expect(generatedCode).toContain('let __mf_0;');
    expect(generatedCode).toContain('let __mf_1;');
    expect(generatedCode).toContain('const __mfApplyEagerShareExports = (mod) => {');
    expect(generatedCode).toContain('__mf_0 = mod["useProducer"];');
    expect(generatedCode).toContain('__mf_1 = mod["createProducer"];');
    expect(generatedCode).toContain('__mf_default = mod.default ?? mod;');
    expect(generatedCode).toContain(
      '__mfSubscribeSharedCache(__mfModuleCache.share, {"canonical":"default:workspace-producer","aliases":["workspace-producer"]}, __mfApplyEagerShareExports);'
    );
    expect(generatedCode).toContain('__mfApplyEagerShareExports(exportModule);');
    expect(generatedCode).toContain('export { __mf_0 as useProducer, __mf_1 as createProducer };');
    expect(generatedCode).not.toContain('export { useProducer, createProducer } from');
    expect(generatedCode).not.toContain('initPromise.then');
    expect(generatedCode).toContain('Promise.resolve().then');
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
    expect(generatedCode).toContain('exportModule = __mfNormalizeShareModule(__mfLocalShare);');
    expect(generatedCode).not.toContain(
      'import("/repo/packages/workspace-name-mismatch/src/index.ts").then((mod) => {'
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
    expectLiveSingletonProxy(generatedCode, pkg, ['useCounter', 'useLogger']);
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
    expectLiveSingletonProxy(generatedCode, pkg, ['useCounter', 'useLogger']);
    expect(generatedCode).not.toContain('__prebuild__');
    expect(generatedCode).not.toContain('import("lit")');
    expect(generatedCode).not.toContain('const {initPromise} = require(');
    expect(generatedCode).not.toContain('await ');
  });

  it('supports SSR and deferred client fallbacks for remote-only bare package singletons', () => {
    normalizeModuleFederationOptions({
      name: 'remote',
      exposes: {
        './App': './src/App.jsx',
      },
      shared: {
        'lit/': {
          singleton: true,
        },
      },
    });
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

    expect(generatedCode).toContain('import * as __mfLocalShare from "lit";');
    expect(generatedCode).toContain('if (import.meta.env.SSR');
    expect(generatedCode).toContain('import("lit").then((mod) => {');
    expect(generatedCode).toContain('export { __mf_default as default };');
    expect(generatedCode).not.toContain('__prebuild__');
    expect(generatedCode).not.toContain('await ');
  });

  it('supports SSR and deferred client fallbacks without subpath sharing', () => {
    normalizeModuleFederationOptions({
      name: 'remote',
      exposes: {
        './App': './src/App.jsx',
      },
      shared: {
        lit: {
          singleton: true,
        },
      },
    });
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

    expect(generatedCode).toContain('import * as __mfLocalShare from "lit";');
    expect(generatedCode).toContain('if (import.meta.env.SSR');
    expect(generatedCode).toContain('import("lit").then((mod) => {');
    expect(generatedCode).toContain('export { __mf_default as default };');
    expect(generatedCode).not.toContain('__prebuild__');
    expect(generatedCode).not.toContain('await ');
  });

  it('uses eager fallback for entry-injected remote singleton deps consumed by peer singletons', () => {
    normalizeModuleFederationOptions({
      name: 'remote',
      hostInitInjectLocation: 'entry',
      exposes: {
        './App': './src/App.jsx',
      },
      shared: {
        react: {
          singleton: true,
        },
        'react-dom': {
          singleton: true,
        },
      },
    });
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

    writeLoadShareModule(pkg, mockShareItem, 'serve', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain('import * as __mfLocalShare from "/resolved/react";');
    expect(generatedCode).toContain('__mfWriteSharedCache');
    expect(generatedCode).toContain('export { __mf_default as default };');
    expect(generatedCode).not.toContain('import("react").then((mod) => {');
    expect(generatedCode).not.toContain('initPromise.then');
    expect(generatedCode).not.toContain('await ');
  });

  it('keeps peer-consumed remote singleton fallbacks lazy without entry injection', () => {
    normalizeModuleFederationOptions({
      name: 'remote',
      exposes: {
        './App': './src/App.jsx',
      },
      shared: {
        react: {
          singleton: true,
        },
        'react-dom': {
          singleton: true,
        },
      },
    });
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

    writeLoadShareModule(pkg, mockShareItem, 'serve', false);

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).not.toContain('import * as __mfLocalShare from "react";');
    expect(generatedCode).toContain('import("/resolved/react").then((mod) => {');
    expect(generatedCode).toContain('initPromise.then');
    expect(generatedCode).not.toContain('await ');
  });

  it('supports SSR and deferred client fallbacks for remote-only package subpath singletons', () => {
    normalizeModuleFederationOptions({
      name: 'remote',
      exposes: {
        './App': './src/App.jsx',
      },
      shared: {
        'lit/': {
          singleton: true,
        },
      },
    });
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

    expect(generatedCode).toContain(
      'import * as __mfLocalShare from "lit/directives/class-map.js";'
    );
    expect(generatedCode).toContain('if (import.meta.env.SSR');
    expect(generatedCode).toContain('import("lit/directives/class-map.js").then((mod) => {');
    expect(generatedCode).toContain('export { __mf_default as default };');
    expect(generatedCode).not.toContain('__prebuild__');
    expect(generatedCode).not.toContain('await ');
  });

  it('generates a live default binding for default-only vue singletons in serve mode', () => {
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
    const cacheDescriptor = '{"canonical":"default:vue","aliases":["vue"]}';

    expect(generatedCode).toContain('const __mfCacheGlobalKey =');
    expect(generatedCode).toContain('let __mfDefaultExport;');
    expect(generatedCode).toContain('const __mfApplySharedDefaultExport = (mod) => {');
    expect(generatedCode).toContain('__mfDefaultExport = mod.default ?? mod;');
    expect(generatedCode).toContain(
      `__mfSubscribeSharedCache(__mfModuleCache.share, ${cacheDescriptor}, __mfApplySharedDefaultExport);`
    );
    expect(generatedCode).toContain('__mfApplySharedDefaultExport(exportModule);');
    expect(generatedCode).toContain('export { __mfDefaultExport as default };');
    expect(generatedCode).toContain('export * from "mock-import-id"');
    expect(generatedCode).not.toContain('export default exportModule.default ?? exportModule');
    expect(generatedCode).not.toContain('module.exports = exportModule');
    expect(generatedCode).not.toContain('await ');
  });

  it('resolves workspace packages with dual ESM/CJS exports to the ESM entry instead of CJS', () => {
    const pkg = 'workspace-dual-format';
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

    // Should use ESM entry (.js), not CJS entry (.cjs)
    expect(generatedCode).toContain('/dist/index.js');
    expect(generatedCode).not.toContain('/dist/index.cjs');
    expect(generatedCode).not.toContain('module.exports');
  });
});

describe('writePreBuildLibPath', () => {
  beforeEach(() => {
    setTreeShakingBuildMode(false);
    writeSyncSpy.mockClear();
  });

  it('keeps the prebuild fallback full and materializes a distinct optimized container', () => {
    const pkg = 'mock-package-with-reserved';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '1.0.0',
      shareConfig: {
        singleton: false,
        strictVersion: false,
        requiredVersion: '^1.0.0',
        treeShaking: { mode: 'runtime-infer', usedExports: ['get'] },
      },
      scope: 'default',
    };

    setTreeShakingBuildMode(true);
    try {
      writePreBuildLibPath(pkg, mockShareItem);

      const generated = writeSyncSpy.mock.calls.map((call) => call[0] as string);
      const optimizedContainer = generated.find((code) => code.includes('__mfTreeShakenModule'));
      const fullFallback = generated.find((code) =>
        code.includes('import * as __mfPrebuildNamespace')
      );

      expect(optimizedContainer).toContain('import { get as __mfTreeShaken_0 }');
      expect(optimizedContainer).toContain('__mf_tree_shaking_graph__=mock-package-with-reserved');
      expect(optimizedContainer).not.toContain('__prebuild__');
      expect(optimizedContainer).toContain('function get()');
      expect(optimizedContainer).toContain('async function init() {}');
      expect(optimizedContainer).toContain('const usedExports = ["get"]');
      expect(fullFallback).toContain('const __mf_0 = __mfPrebuildExports["delete"]');
      expect(fullFallback).toContain('const __mf_2 = __mfPrebuildExports["request"]');
      expect(hasTreeShakingSharedProvider(pkg, mockShareItem)).toBe(true);
      expect(getTreeShakingSharedProviderImportId(pkg)).toBe('mock-import-id');

      writeSyncSpy.mockClear();
      writeLoadShareModule(pkg, mockShareItem, 'build', false);
      const loadShareCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;
      expect(loadShareCode).toContain('__mfReadTreeShakingSharedSelection');
      expect(loadShareCode).toContain('"test"');
      expect(loadShareCode).toContain('pendingShareLoads');
      expect(loadShareCode).not.toContain('import * as __mfLocalShare');
    } finally {
      setTreeShakingBuildMode(false);
    }
  });

  it('defines __proto__ as an own export property in optimized containers', () => {
    const pkg = 'mock-package-with-reserved';
    const mockShareItem: ShareItem = {
      name: pkg,
      from: '',
      version: '1.0.0',
      shareConfig: {
        singleton: false,
        requiredVersion: '^1.0.0',
        treeShaking: { mode: 'runtime-infer', usedExports: ['__proto__'] },
      },
      scope: 'default',
    };

    setTreeShakingBuildMode(true);
    try {
      writePreBuildLibPath(pkg, mockShareItem);
      const optimizedContainer = writeSyncSpy.mock.calls
        .map((call) => call[0] as string)
        .find((code) => code.includes('__mfTreeShakenModule'));

      expect(optimizedContainer).toContain('["__proto__"]: __mfTreeShaken_0');
      expect(optimizedContainer).not.toContain('"__proto__": __mfTreeShaken_0');
    } finally {
      setTreeShakingBuildMode(false);
    }
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
      'export default Reflect.get(__mfPrebuildExports, "default") ?? __mfPrebuildExports;'
    );
  });

  // Regression: the namedExports branch previously emitted
  // `export default __mfPrebuildExports` (the namespace object) instead of
  // unwrapping `.default`. That broke CJS-interop `import React from 'react'`
  // consumers, whose real default lives at `namespace.default`.
  // Fix: emit `namespace.default ?? namespace`, matching the fallback branch.
  it('unwraps namespace.default in the named-exports branch for CJS-interop consumers', () => {
    writePreBuildLibPath('mock-package-with-reserved');

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain(
      'export default Reflect.get(__mfPrebuildNamespace, "default") ?? __mfPrebuildNamespace;'
    );
    expect(generatedCode).not.toMatch(/export default __mfPrebuildExports;\s*$/m);
  });

  // ── pendingShareLoads: deferred export assignment ──────────────────────────
  //
  // Race condition: init() seeds __mfModuleCache.share with the loadShare
  // module's _exports (getters returning undefined until initPromise
  // resolves + ESM import completes). When a cached exportModule exists at
  // loadShare evaluation time (seeded by initHost -> runtime.loadShare), the
  // else branch applies exports synchronously — the cache is already populated
  // and remotes have no bootstrap to await pendingShareLoads.
  // The undefined branch (cache miss) defers via pendingShareLoads for the
  // host bootstrap to await.

  it('applies lazy share exports synchronously in else branch (build mode)', () => {
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

    // The else branch (cached exportModule) must apply exports synchronously
    // instead of deferring to pendingShareLoads (remotes have no bootstrap).
    // There are two else branches: inner (SSR vs client) and outer (cached vs undefined).
    // Find the outer else — the last one in the generated code.
    const elseMatches = [...generatedCode.matchAll(/} else \{/g)];
    const outerElse = elseMatches[elseMatches.length - 1];
    expect(outerElse).toBeDefined();
    const afterElse = generatedCode.slice(outerElse.index, outerElse.index + 200);
    expect(afterElse).toContain('__mfApplyLazyShareExports');
    expect(afterElse).not.toContain('pendingShareLoads');
  });

  it('pushes lazy share load to pendingShareLoads in client-side undefined branch (build mode)', () => {
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

    // The non-SSR undefined branch must also use pendingShareLoads
    // instead of a bare initPromise.then()
    expect(generatedCode).toContain('pendingShareLoads');
    expect(generatedCode).toContain('initPromise.then');
    expect(generatedCode).toContain('__mfReadSharedCache(__mfModuleCache.share');
    expect(generatedCode).toContain('if (exportModule !== undefined)');
    expect(generatedCode).toContain('return import(');

    // Must use the ||= pattern for lazy initialization
    expect(generatedCode).toContain('||= []');
  });

  it('does not use bare initPromise.then without pendingShareLoads in build mode', () => {
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

    // Every initPromise.then() must be wrapped in a pendingShareLoads push.
    const pushCount = (generatedCode.match(/pendingShareLoads/g) || []).length;
    const thenCount = (generatedCode.match(/initPromise\.then/g) || []).length;
    expect(pushCount).toBeGreaterThanOrEqual(thenCount);
  });

  it('pushes host-provided share load to pendingShareLoads in else branch (import: false)', () => {
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

    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    // For import:false shares using generateDeferredHostProvidedExports,
    // the else branch (cache already populated) must apply exports synchronously
    expect(generatedCode).toContain('__mfApplyHostProvidedExports');
    expect(generatedCode).toContain('__mfModuleCache.share');
    expect(generatedCode).toContain('initPromise.then');
  });
});

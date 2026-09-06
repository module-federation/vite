import { beforeEach, vi } from 'vitest';
import {
  ModuleFederationOptions,
  normalizeModuleFederationOptions,
  RemoteObjectConfig,
} from '../normalizeModuleFederationOptions';
import { setPackageDetectionCwd } from '../packageUtils';

const { mfErrorSpy, mfWarnSpy } = vi.hoisted(() => ({
  mfErrorSpy: vi.fn(),
  mfWarnSpy: vi.fn(),
}));

vi.mock('../logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logger')>();
  return {
    ...actual,
    mfError: (...args: unknown[]) => mfErrorSpy(...args),
    mfWarn: (...args: unknown[]) => mfWarnSpy(...args),
  };
});

describe('normalizeModuleFederationOption', () => {
  const minimalOptions: ModuleFederationOptions = {
    name: 'test-module',
    shareStrategy: 'loaded-first',
  };

  it('should set default values', () => {
    expect(normalizeModuleFederationOptions(minimalOptions)).toEqual({
      exposes: {},
      filename: 'remoteEntry-[hash]',
      internalName: '__mfe_internal__test-module',
      library: undefined,
      name: 'test-module',
      remotes: {},
      shareScope: 'default',
      shared: {},
      runtime: undefined,
      runtimePlugins: [],
      implementation: expect.stringMatching(/@module-federation\/runtime\/dist\/index\.js$/),
      manifest: undefined,
      dev: undefined,
      dts: undefined,
      shareStrategy: 'loaded-first',
      ignoreOrigin: false,
      virtualModuleDir: '__mf__virtual',
      hostInitInjectLocation: 'html',
      bundleAllCSS: false,
      treeShakingDir: undefined,
      injectTreeShakingUsedExports: undefined,
      treeShakingSharedPlugins: undefined,
      treeShakingSharedExcludePlugins: undefined,
      getPublicPath: undefined,
      publicPath: undefined,
      moduleParseTimeout: 10,
      moduleParseIdleTimeout: undefined,
      target: undefined,
      ssrExternals: undefined,
      disableRemote: undefined,
      disableShared: undefined,
      disableSnapshot: undefined,
      varFilename: undefined,
      experiments: {
        externalRuntime: false,
        provideExternalRuntime: false,
        ssrMode: undefined,
      },
    });
  });

  it('preserves ssrExternals for the SSR remote entry', () => {
    expect(
      normalizeModuleFederationOptions({
        ...minimalOptions,
        ssrExternals: ['sharp'],
      }).ssrExternals
    ).toEqual(['sharp']);
  });

  it('normalizes experiments.ssrMode as an explicit island opt-in', () => {
    expect(normalizeModuleFederationOptions(minimalOptions).experiments.ssrMode).toBeUndefined();
    expect(
      normalizeModuleFederationOptions({
        ...minimalOptions,
        experiments: { ssrMode: 'ISLAND' },
      }).experiments.ssrMode
    ).toBe('ISLAND');
  });

  it('warns when island mode is combined with shared React', () => {
    mfWarnSpy.mockClear();

    normalizeModuleFederationOptions({
      ...minimalOptions,
      experiments: { ssrMode: 'ISLAND' },
      shared: { react: { singleton: true } },
    });

    expect(mfWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Island expose generation is disabled because experiments.ssrMode is "ISLAND" and React is configured as shared'
      )
    );
  });

  it('normalizes experiments.externalRuntime and provideExternalRuntime', () => {
    expect(
      normalizeModuleFederationOptions({
        ...minimalOptions,
        experiments: {
          externalRuntime: true,
          provideExternalRuntime: true,
        },
      }).experiments
    ).toEqual({
      externalRuntime: true,
      provideExternalRuntime: true,
    });
  });

  it('defaults experiments flags to false when omitted', () => {
    expect(normalizeModuleFederationOptions(minimalOptions).experiments).toEqual({
      externalRuntime: false,
      provideExternalRuntime: false,
    });
  });

  it('preserves runtime capability optimization options', () => {
    const normalized = normalizeModuleFederationOptions({
      ...minimalOptions,
      disableRemote: true,
      disableShared: true,
      disableSnapshot: true,
    });

    expect(normalized).toMatchObject({
      disableRemote: true,
      disableShared: true,
      disableSnapshot: true,
    });
  });

  it('preserves multiple provider share scopes', () => {
    expect(
      normalizeModuleFederationOptions({
        ...minimalOptions,
        shareScope: ['default', 'scope1'],
      }).shareScope
    ).toEqual(['default', 'scope1']);
  });

  it('maps reserved remote name internally', () => {
    mfWarnSpy.mockClear();

    const normalized = normalizeModuleFederationOptions({
      ...minimalOptions,
      name: 'scheduler',
    });

    expect(normalized.name).toBe('scheduler');
    expect(normalized.internalName).toBe('__mfe_internal__scheduler');
    expect(mfWarnSpy).not.toHaveBeenCalled();
  });

  it('warns when public name uses reserved internal prefix', () => {
    mfWarnSpy.mockClear();

    normalizeModuleFederationOptions({
      ...minimalOptions,
      name: '__mfe_internal__scheduler',
    });

    expect(mfWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Reserved internal containerName prefix "__mfe_internal__" detected')
    );
  });

  describe('exposes', () => {
    it('should normalize an expose with a string value', () => {
      expect(
        normalizeModuleFederationOptions({
          ...minimalOptions,
          exposes: {
            './Button': 'src/Button.js',
          },
        }).exposes
      ).toEqual({
        './Button': {
          import: 'src/Button.js',
        },
      });
    });

    it('should normalize an expose with an object value', () => {
      expect(
        normalizeModuleFederationOptions({
          ...minimalOptions,
          exposes: {
            './Button': {
              import: 'src/Button.js',
            },
          },
        }).exposes
      ).toEqual({
        './Button': {
          import: 'src/Button.js',
        },
      });
    });
  });

  describe('remotes', () => {
    beforeEach(() => {
      mfWarnSpy.mockClear();
    });

    it('should normalize a remote with a string value', () => {
      expect(
        normalizeModuleFederationOptions({
          ...minimalOptions,
          remotes: {
            remote1: 'Button@http://localhost:3001/remoteEntry.js',
          },
        }).remotes
      ).toEqual({
        remote1: {
          type: 'var',
          name: 'remote1',
          internalName: '__mfe_internal__remote1',
          entry: 'http://localhost:3001/remoteEntry.js',
          entryGlobalName: 'Button',
          shareScope: 'default',
        },
      });
    });

    it('should normalize a scoped-package remote string', () => {
      expect(
        normalizeModuleFederationOptions({
          ...minimalOptions,
          remotes: {
            remote1: '@scope/app@http://localhost:3001/remoteEntry.js',
          },
        }).remotes
      ).toEqual({
        remote1: {
          type: 'var',
          name: 'remote1',
          internalName: '__mfe_internal__remote1',
          entry: 'http://localhost:3001/remoteEntry.js',
          entryGlobalName: '@scope/app',
          shareScope: 'default',
        },
      });
    });

    it('should normalize a remote string when the entry URL contains "@"', () => {
      expect(
        normalizeModuleFederationOptions({
          ...minimalOptions,
          remotes: {
            remote1: 'Button@http://user:password@localhost:3001/remoteEntry.js',
          },
        }).remotes
      ).toEqual({
        remote1: {
          type: 'var',
          name: 'remote1',
          internalName: '__mfe_internal__remote1',
          entry: 'http://user:password@localhost:3001/remoteEntry.js',
          entryGlobalName: 'Button',
          shareScope: 'default',
        },
      });
    });

    it('should normalize a remote with an object value', () => {
      expect(
        normalizeModuleFederationOptions({
          ...minimalOptions,
          remotes: {
            remote1: {
              name: 'remote1',
              entry: 'http://localhost:3001/remoteEntry.js',
              entryGlobalName: 'Button',
            },
          },
        }).remotes
      ).toEqual({
        remote1: {
          type: 'var',
          name: 'remote1',
          internalName: '__mfe_internal__remote1',
          entry: 'http://localhost:3001/remoteEntry.js',
          entryGlobalName: 'Button',
          shareScope: 'default',
        },
      });
    });

    it('warns when object remote omits type and defaults to var', () => {
      const remotes = normalizeModuleFederationOptions({
        ...minimalOptions,
        remotes: {
          omittedObjectRemote: {
            name: 'omittedObjectRemote',
            entry: 'http://localhost:3001/remoteEntry.js',
          },
        },
      }).remotes;

      expect(remotes.omittedObjectRemote.type).toBe('var');
      expect(mfWarnSpy).toHaveBeenCalledTimes(1);
      expect(mfWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Remote "omittedObjectRemote" omits type and defaults to \'var\'')
      );
    });

    it('warns independently for separate configs using the same remote alias', () => {
      const options = {
        ...minimalOptions,
        remotes: {
          repeatedRemote: {
            name: 'repeatedRemote',
            entry: 'http://localhost:3001/remoteEntry.js',
          },
        },
      };

      normalizeModuleFederationOptions(options);
      normalizeModuleFederationOptions(options);

      expect(mfWarnSpy).toHaveBeenCalledTimes(2);
    });

    it('does not warn for string remote syntax', () => {
      normalizeModuleFederationOptions({
        ...minimalOptions,
        remotes: {
          omittedStringRemote: 'Button@http://localhost:3001/remoteEntry.js',
        },
      });

      expect(mfWarnSpy).not.toHaveBeenCalled();
    });

    it('does not warn when object remote sets type: module', () => {
      normalizeModuleFederationOptions({
        ...minimalOptions,
        remotes: {
          remote1: {
            type: 'module',
            name: 'remote1',
            entry: 'http://localhost:3001/remoteEntry.js',
          },
        },
      });

      expect(mfWarnSpy).not.toHaveBeenCalled();
    });

    it('does not warn when object remote sets type: var', () => {
      const remotes = normalizeModuleFederationOptions({
        ...minimalOptions,
        remotes: {
          explicitVarRemote: {
            type: 'var',
            name: 'explicitVarRemote',
            entry: 'http://localhost:3001/remoteEntry.js',
          },
        },
      }).remotes;

      expect(remotes.explicitVarRemote.type).toBe('var');
      expect(mfWarnSpy).not.toHaveBeenCalled();
    });

    it.each([
      ['undefined', undefined],
      ['empty', ''],
      ['null', null],
    ])('normalizes omitted-like %s type to var', (remoteName, type) => {
      const remotes = normalizeModuleFederationOptions({
        ...minimalOptions,
        remotes: {
          [remoteName]: {
            type,
            name: remoteName,
            entry: 'http://localhost:3001/remoteEntry.js',
          } as RemoteObjectConfig,
        },
      }).remotes;

      expect(remotes[remoteName].type).toBe('var');
      expect(mfWarnSpy).toHaveBeenCalledTimes(1);
    });

    it('warns when remote alias uses reserved internal prefix', () => {
      normalizeModuleFederationOptions({
        ...minimalOptions,
        remotes: {
          __mfe_internal__remote1: 'Button@http://localhost:3001/remoteEntry.js',
        },
      });

      expect(mfWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Reserved internal remoteAlias prefix "__mfe_internal__" detected')
      );
    });

    it('preserves multiple share scopes on remote config', () => {
      expect(
        normalizeModuleFederationOptions({
          ...minimalOptions,
          remotes: {
            remote1: {
              name: 'remote1',
              entry: 'http://localhost:3001/remoteEntry.js',
              shareScope: ['default', 'scope1'],
            },
          },
        }).remotes.remote1.shareScope
      ).toEqual(['default', 'scope1']);
    });
  });

  describe('shared', () => {
    it('normalizes a string array', () => {
      expect(
        normalizeModuleFederationOptions({
          ...minimalOptions,
          shared: ['dep1', 'dep2'],
        }).shared
      ).toEqual({
        dep1: {
          from: '',
          name: 'dep1',
          scope: 'default',
          version: undefined,
          shareConfig: {
            import: undefined,
            eager: false,
            requiredVersion: '*',
            singleton: false,
          },
        },
        dep2: {
          from: '',
          name: 'dep2',
          scope: 'default',
          version: undefined,
          shareConfig: {
            import: undefined,
            eager: false,
            requiredVersion: '*',
            singleton: false,
          },
        },
      });
    });

    it('normalizes an object', () => {
      expect(
        normalizeModuleFederationOptions({
          ...minimalOptions,
          shared: {
            dep1: {
              version: '1.0.0',
            },
            dep2: {
              requiredVersion: '^2.0.0',
              strictVersion: true,
              singleton: true,
            },
          },
        }).shared
      ).toEqual({
        dep1: {
          from: '',
          name: 'dep1',
          scope: 'default',
          version: '1.0.0',
          shareConfig: {
            requiredVersion: '*',
            singleton: false,
            eager: false,
            strictVersion: false,
          },
        },
        dep2: {
          from: '',
          name: 'dep2',
          scope: 'default',
          version: '2.0.0',
          shareConfig: {
            requiredVersion: '^2.0.0',
            singleton: true,
            eager: false,
            strictVersion: true,
          },
        },
      });
    });

    it('preserves eager shared configuration', () => {
      const normalized = normalizeModuleFederationOptions({
        ...minimalOptions,
        shared: {
          react: { singleton: true, eager: true },
        },
      });

      expect(normalized.shared.react.shareConfig.eager).toBe(true);
    });

    it('rejects eager shared configuration combined with tree shaking', () => {
      expect(() =>
        normalizeModuleFederationOptions({
          ...minimalOptions,
          shared: {
            antd: { eager: true, treeShaking: { mode: 'runtime-infer' } },
          },
        })
      ).toThrow(/cannot use both "eager: true" and "treeShaking\.mode" simultaneously/);
    });

    it('preserves tree-shaking configuration on shared items', () => {
      expect(
        normalizeModuleFederationOptions({
          ...minimalOptions,
          shared: {
            antd: {
              singleton: true,
              treeShaking: {
                mode: 'server-calc',
                usedExports: ['Button'],
              },
            },
          },
        }).shared.antd.shareConfig.treeShaking
      ).toEqual({
        mode: 'server-calc',
        usedExports: ['Button'],
      });
    });

    it('warns but allows singleton runtime inference', () => {
      mfWarnSpy.mockClear();

      const normalized = normalizeModuleFederationOptions({
        ...minimalOptions,
        shared: {
          antd: { singleton: true, treeShaking: { mode: 'runtime-infer' } },
        },
      });

      expect(normalized.shared.antd.shareConfig.treeShaking).toEqual({
        mode: 'runtime-infer',
      });
      expect(mfWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Prefer server-calc'));
    });

    it('rejects an omitted tree-shaking mode', () => {
      expect(() =>
        normalizeModuleFederationOptions({
          ...minimalOptions,
          shared: {
            antd: { treeShaking: { usedExports: ['Button'] } as any },
          },
        })
      ).toThrow(/treeShaking\.mode must be either/);
    });

    it('rejects an invalid tree-shaking mode', () => {
      expect(() =>
        normalizeModuleFederationOptions({
          ...minimalOptions,
          shared: {
            antd: { treeShaking: { mode: 'invalid' } as any },
          },
        })
      ).toThrow(/treeShaking\.mode must be either/);
    });

    it('preserves top-level tree-shaking options', () => {
      const normalized = normalizeModuleFederationOptions({
        ...minimalOptions,
        treeShakingDir: 'independent-packages',
        injectTreeShakingUsedExports: false,
        treeShakingSharedPlugins: ['shared-build-plugin'],
        treeShakingSharedExcludePlugins: ['excluded-build-plugin'],
      });

      expect(normalized).toMatchObject({
        treeShakingDir: 'independent-packages',
        injectTreeShakingUsedExports: false,
        treeShakingSharedPlugins: ['shared-build-plugin'],
        treeShakingSharedExcludePlugins: ['excluded-build-plugin'],
      });
    });

    it('preserves requiredVersion: false to disable version constraints', () => {
      const shared = normalizeModuleFederationOptions({
        ...minimalOptions,
        shared: {
          dep1: {
            requiredVersion: false,
            strictVersion: true,
          },
        },
      }).shared;

      expect(shared.dep1.shareConfig).toMatchObject({
        requiredVersion: false,
        strictVersion: true,
      });
    });

    it('ignores package-manager protocol requiredVersion and falls back to installed version', () => {
      const path = require('node:path');
      const fs = require('node:fs');
      const fixtureRoot = path.join(
        require('node:os').tmpdir(),
        'mf-vite-protocol-required-version'
      );
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
      const reactDir = path.join(fixtureRoot, 'node_modules/react');
      fs.mkdirSync(reactDir, { recursive: true });
      fs.writeFileSync(
        path.join(fixtureRoot, 'package.json'),
        JSON.stringify({ name: 'consumer-app', dependencies: { react: 'catalog:' } })
      );
      fs.writeFileSync(
        path.join(reactDir, 'package.json'),
        JSON.stringify({ name: 'react', version: '19.2.7', main: 'index.js' })
      );
      fs.writeFileSync(path.join(reactDir, 'index.js'), '');

      setPackageDetectionCwd(fixtureRoot);

      try {
        for (const protocol of [
          'catalog:',
          'catalog:react19',
          'workspace:*',
          'npm:react@^19.0.0',
          'patch:react@19.2.7#./patches/react.patch',
          'file:../react',
          'link:../react',
          'portal:../react',
          'exec:./build-react.js',
          'jsr:@scope/react@^19.0.0',
          'git:https://github.com/facebook/react.git',
          'git+https://github.com/facebook/react.git',
          'https://registry.example.com/react.tgz',
          'github:facebook/react',
          '',
        ]) {
          const shared = normalizeModuleFederationOptions({
            ...minimalOptions,
            shared: {
              react: {
                singleton: true,
                requiredVersion: protocol,
              },
            },
          }).shared;

          expect.soft(shared.react.shareConfig.requiredVersion, protocol).toBe('^19.2.7');
        }

        // Real ranges — including leading spaces / compound OR — stay unchanged.
        // Do not use isRequiredVersion(); it only checks a prefix regex.
        for (const range of ['^19.0.0', ' >= 8.0.0', '* || ^8.0.0']) {
          const shared = normalizeModuleFederationOptions({
            ...minimalOptions,
            shared: {
              react: {
                singleton: true,
                requiredVersion: range,
              },
            },
          }).shared;
          expect(shared.react.shareConfig.requiredVersion).toBe(range);
        }
      } finally {
        setPackageDetectionCwd(process.cwd());
      }
    });

    it('falls back to * when protocol requiredVersion has no installed package', () => {
      const shared = normalizeModuleFederationOptions({
        ...minimalOptions,
        shared: {
          'missing-protocol-dep': {
            singleton: true,
            requiredVersion: 'catalog:',
          },
        },
      }).shared;

      expect(shared['missing-protocol-dep'].shareConfig.requiredVersion).toBe('*');
    });

    it('preserves react/ as a namespace prefix and collapses react-dom/', () => {
      const shared = normalizeModuleFederationOptions({
        ...minimalOptions,
        shared: {
          'react/': {
            singleton: true,
            requiredVersion: '^19.0.0',
          },
          'react-dom/': {
            singleton: true,
            import: false,
          },
          '@scope/ui/': {
            singleton: true,
          },
        },
      }).shared;

      // react/ stays a prefix so consumer-only (and provider) shares cover any
      // actually-imported subpath instead of a hardcoded JSX export list.
      expect(shared['react/']).toMatchObject({
        name: 'react/',
        shareConfig: {
          singleton: true,
          requiredVersion: '^19.0.0',
        },
      });
      expect(shared.react).toBeUndefined();
      // react-dom/ must not become a browser-wide prefix: that would also
      // capture react-dom/server*. Collapse to the package root instead.
      expect(shared['react-dom']).toMatchObject({
        name: 'react-dom',
        shareConfig: {
          import: false,
          singleton: true,
        },
      });
      expect(shared['react-dom/']).toBeUndefined();
      expect(shared['@scope/ui/']).toBeDefined();
    });

    it('collapses solid-js/ and zustand/ to the package root', () => {
      const shared = normalizeModuleFederationOptions({
        ...minimalOptions,
        shared: {
          'solid-js/': {
            singleton: true,
          },
          'zustand/': {
            singleton: true,
            import: false,
          },
        },
      }).shared;

      expect(shared['solid-js']).toMatchObject({
        name: 'solid-js',
        shareConfig: {
          singleton: true,
        },
      });
      expect(shared['solid-js/']).toBeUndefined();
      expect(shared.zustand).toMatchObject({
        name: 'zustand',
        shareConfig: {
          import: false,
          singleton: true,
        },
      });
      expect(shared['zustand/']).toBeUndefined();
    });

    it('preserves consumer-only react/ with import: false as a namespace prefix', () => {
      const shared = normalizeModuleFederationOptions({
        ...minimalOptions,
        shared: {
          'react/': {
            singleton: true,
            import: false,
          },
        },
      }).shared;

      expect(shared['react/']).toMatchObject({
        name: 'react/',
        shareConfig: {
          singleton: true,
          import: false,
        },
      });
      expect(shared.react).toBeUndefined();
    });

    it('prefers the installed package version over an inferred requiredVersion', () => {
      const path = require('node:path');
      const fs = require('node:fs');
      const fixtureRoot = path.join(require('node:os').tmpdir(), 'mf-vite-required-version');
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
      const reactDir = path.join(fixtureRoot, 'node_modules/react');
      fs.mkdirSync(reactDir, { recursive: true });
      fs.writeFileSync(
        path.join(fixtureRoot, 'package.json'),
        JSON.stringify({ name: 'consumer-app', dependencies: { react: '19.2.7' } })
      );
      fs.writeFileSync(
        path.join(reactDir, 'package.json'),
        JSON.stringify({ name: 'react', version: '19.2.7', main: 'index.js' })
      );
      fs.writeFileSync(path.join(reactDir, 'index.js'), '');

      setPackageDetectionCwd(fixtureRoot);

      try {
        const shared = normalizeModuleFederationOptions({
          ...minimalOptions,
          shared: {
            react: {
              singleton: true,
              requiredVersion: '^19.1.1',
            },
          },
        }).shared;

        expect(shared.react.version).toBe('19.2.7');
        expect(shared.react.shareConfig.requiredVersion).toBe('^19.1.1');
      } finally {
        setPackageDetectionCwd(process.cwd());
      }
    });

    it('infers versions from ranges without a backtracking regular expression', () => {
      for (const [requiredVersion, expected] of [
        ['^19.1.1', '19.1.1'],
        ['>=1.2.3-beta.1', '1.2.3-beta.1'],
        ['workspace:^', undefined],
        [`${'9'.repeat(100_000)}x1.2.3`, '1.2.3'],
      ] as const) {
        const shared = normalizeModuleFederationOptions({
          ...minimalOptions,
          shared: {
            'missing-version-dep': { requiredVersion },
          },
        }).shared;

        expect(shared['missing-version-dep'].version).toBe(expected);
      }
    });

    it('ignores module federation runtime packages in explicit shared arrays', () => {
      const shared = normalizeModuleFederationOptions({
        ...minimalOptions,
        shared: ['dep1', '@module-federation/runtime', '@module-federation/runtime-core'],
      }).shared;

      expect(shared.dep1).toBeDefined();
      expect(shared['@module-federation/runtime']).toBeUndefined();
      expect(shared['@module-federation/runtime-core']).toBeUndefined();
    });

    it('ignores module federation runtime packages in explicit shared objects', () => {
      const shared = normalizeModuleFederationOptions({
        ...minimalOptions,
        shared: {
          dep1: { singleton: true },
          '@module-federation/runtime': { singleton: true },
          '@module-federation/runtime-core': { singleton: true },
        },
      }).shared;

      expect(shared.dep1).toBeDefined();
      expect(shared['@module-federation/runtime']).toBeUndefined();
      expect(shared['@module-federation/runtime-core']).toBeUndefined();
    });

    it('resolves version for import: false when package is installed', () => {
      mfErrorSpy.mockClear();

      // Version resolution is required even when import: false.
      // The `import: false` flag indicates "this app does not PROVIDE the module"
      // (it must be supplied by the host), but the runtime still needs to know
      // the version for share scope registration and singleton validation.
      // Without a resolved version, the MF runtime defaults to version "0",
      // which breaks satisfy() checks and causes false-positive singleton warnings.
      const result = normalizeModuleFederationOptions({
        ...minimalOptions,
        shared: {
          react: {
            import: false,
            singleton: true,
          },
        },
      }).shared;

      // Should resolve version from react's package.json
      expect(result['react'].version).toBeDefined();
      expect(result['react'].version).not.toBe('0');
      expect(result['react'].shareConfig.requiredVersion).toBe('*');
      expect(result['react'].shareConfig.import).toBe(false);
      expect(result['react'].shareConfig.singleton).toBe(true);
    });

    it('does not error when version resolution fails for import: false', () => {
      mfErrorSpy.mockClear();

      const result = normalizeModuleFederationOptions({
        ...minimalOptions,
        shared: {
          'not-installed-pkg': {
            import: false,
            singleton: true,
          },
        },
      }).shared;

      // Should not trigger any mfError calls for unresolvable packages when import: false
      expect(mfErrorSpy).not.toHaveBeenCalled();

      // Version should be undefined but should not cause runtime issues
      // because the host should provide this module
      expect(result['not-installed-pkg']).toEqual({
        from: '',
        name: 'not-installed-pkg',
        scope: 'default',
        version: undefined,
        shareConfig: {
          import: false,
          eager: false,
          requiredVersion: '*',
          singleton: true,
          strictVersion: false,
        },
      });
    });

    it('resolves the parent package version for a shared subpath key', () => {
      // When a shared key is a subpath like
      // "@scope/foo/bar", searchPackageVersion() used to look up the pnpm
      // store for a package literally named "@scope/foo/bar", which never
      // exists. The resolved version stayed undefined, and the consumer's
      // singleton/requiredVersion matching against the host's registered
      // share broke at runtime, raising "Shared module '...' must be
      // provided by host". The fix is to let getInstalledPackageJson
      // derive the bare package name via getPackageName() so the lookup
      // finds the parent package.
      //
      // The fixture mimics a pnpm strict install where the parent package
      // is only reachable through node_modules/.pnpm — there's no
      // node_modules/@scope/foo/package.json, so the earlier
      // require()-based resolution paths in normalizeShareItem must miss
      // and the searchPackageVersion fallback must succeed.
      mfErrorSpy.mockClear();

      const path = require('node:path');
      const fs = require('node:fs');
      const fixtureRoot = path.join(require('node:os').tmpdir(), 'mf-vite-subpath-share');
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
      const pnpmPkgDir = path.join(
        fixtureRoot,
        'node_modules/.pnpm/@scope+web-client@7.0.0/node_modules/@scope/web-client'
      );
      fs.mkdirSync(pnpmPkgDir, { recursive: true });
      fs.writeFileSync(
        path.join(fixtureRoot, 'package.json'),
        JSON.stringify({ name: 'consumer-app', dependencies: {} })
      );
      fs.writeFileSync(
        path.join(pnpmPkgDir, 'package.json'),
        JSON.stringify({
          name: '@scope/web-client',
          version: '7.0.0',
          exports: { '.': './index.js', './graph': './graph.js' },
        })
      );

      setPackageDetectionCwd(fixtureRoot);

      const shared = normalizeModuleFederationOptions({
        ...minimalOptions,
        shared: {
          '@scope/web-client': { import: false, singleton: true },
          '@scope/web-client/graph': { import: false, singleton: true },
        },
      }).shared;

      expect(shared['@scope/web-client'].version).toBe('7.0.0');
      // The bug: this used to be undefined for the subpath.
      expect(shared['@scope/web-client/graph'].version).toBe('7.0.0');

      setPackageDetectionCwd(process.cwd());
    });

    it('does not implicitly share dependencies', () => {
      const fixtureRoot = require('node:path').join(
        require('node:os').tmpdir(),
        'mf-vite-no-auto-share'
      );
      require('node:fs').rmSync(fixtureRoot, { force: true, recursive: true });
      require('node:fs').mkdirSync(fixtureRoot, { recursive: true });
      require('node:fs').writeFileSync(
        require('node:path').join(fixtureRoot, 'package.json'),
        JSON.stringify({
          name: 'consumer-app',
          dependencies: { vue: '^3.5.29' },
          peerDependencies: { react: '^19.0.0' },
        })
      );
      setPackageDetectionCwd(fixtureRoot);

      try {
        expect(normalizeModuleFederationOptions(minimalOptions).shared).toEqual({});
      } finally {
        setPackageDetectionCwd(process.cwd());
        require('node:fs').rmSync(fixtureRoot, { force: true, recursive: true });
      }
    });
  });

  describe('manifest', () => {
    it('returns undefined if manifest is not set', () => {
      expect(normalizeModuleFederationOptions(minimalOptions).manifest).toBeUndefined();
    });

    it('returns true if manifest is set to true', () => {
      expect(
        normalizeModuleFederationOptions({
          ...minimalOptions,
          manifest: true,
        }).manifest
      ).toBe(true);
    });

    it('returns false if manifest is set to false', () => {
      expect(
        normalizeModuleFederationOptions({
          ...minimalOptions,
          manifest: false,
        }).manifest
      ).toBe(false);
    });

    it('returns options in case manifest is an option object', () => {
      expect(
        normalizeModuleFederationOptions({
          ...minimalOptions,
          manifest: {
            fileName: 'test-manifest.json',
            disableAssetsAnalyze: true,
            filePath: 'test-path',
          },
        }).manifest
      ).toEqual({
        fileName: 'test-manifest.json',
        disableAssetsAnalyze: true,
        filePath: 'test-path',
      });
    });

    it('returns default values if manifest is an empty object', () => {
      expect(
        normalizeModuleFederationOptions({
          ...minimalOptions,
          manifest: {},
        }).manifest
      ).toEqual({
        fileName: 'mf-manifest.json',
      });
    });
  });

  describe('virtualModuleDir', () => {
    it('should use default value when not specified', () => {
      expect(
        normalizeModuleFederationOptions({
          ...minimalOptions,
        }).virtualModuleDir
      ).toEqual('__mf__virtual');
    });

    it('should use custom value when specified', () => {
      expect(
        normalizeModuleFederationOptions({
          ...minimalOptions,
          virtualModuleDir: '__mf__virtual__app_name',
        }).virtualModuleDir
      ).toEqual('__mf__virtual__app_name');
    });

    it('should throw an error when virtualModuleDir contains slashes', () => {
      expect(() => {
        normalizeModuleFederationOptions({
          ...minimalOptions,
          virtualModuleDir: '__mf__virtual/app_name',
        });
      }).toThrow(/Invalid virtualModuleDir/);
    });

    it('should throw an error with helpful message when path-like value is used', () => {
      expect(() => {
        normalizeModuleFederationOptions({
          ...minimalOptions,
          virtualModuleDir: '/path/to/__mf__virtual',
        });
      }).toThrow(
        'Invalid virtualModuleDir: "/path/to/__mf__virtual". ' +
          'The virtualModuleDir option cannot contain slashes (/). ' +
          "Please use a single directory name like '__mf__virtual__your_app_name'."
      );
    });

    it('should handle empty string by falling back to default', () => {
      expect(
        normalizeModuleFederationOptions({
          ...minimalOptions,
          virtualModuleDir: '',
        }).virtualModuleDir
      ).toEqual('__mf__virtual');
    });

    it('should handle undefined by falling back to default', () => {
      expect(
        normalizeModuleFederationOptions({
          ...minimalOptions,
          virtualModuleDir: undefined,
        }).virtualModuleDir
      ).toEqual('__mf__virtual');
    });
  });
});

import {
  ModuleFederationOptions,
  normalizeModuleFederationOptions,
} from '../normalizeModuleFederationOptions';

describe('normalizeModuleFederationOption', () => {
  const minimalOptions: ModuleFederationOptions = {
    name: 'test-module',
    shareStrategy: 'loaded-first',
  };

  it('should set default values', () => {
    expect(normalizeModuleFederationOptions(minimalOptions)).toEqual({
      exposes: {},
      filename: 'remoteEntry-[hash]',
      library: undefined,
      name: 'test-module',
      remotes: {},
      shareScope: 'default',
      shared: {},
      runtime: undefined,
      runtimePlugins: [],
      implementation: require.resolve('@module-federation/runtime'),
      manifest: false,
      dev: undefined,
      dts: undefined,
      shareStrategy: 'loaded-first',
      ignoreOrigin: false,
      virtualModuleDir: '__mf__virtual',
    });
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
          entry: 'http://localhost:3001/remoteEntry.js',
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
          entry: 'http://localhost:3001/remoteEntry.js',
          entryGlobalName: 'Button',
          shareScope: 'default',
        },
      });
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
            strictVersion: false,
          },
        },
        dep2: {
          from: '',
          name: 'dep2',
          scope: 'default',
          version: undefined,
          shareConfig: {
            requiredVersion: '^2.0.0',
            singleton: true,
            strictVersion: true,
          },
        },
      });
    });
  });

  describe('manifest', () => {
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
        disableAssetsAnalyze: false,
        filePath: '',
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
          virtualModuleDir: '/custom-path/__mf__virtual',
        }).virtualModuleDir
      ).toEqual('/custom-path/__mf__virtual');
    });

    it('should allow renaming the virtual directory', () => {
      expect(
        normalizeModuleFederationOptions({
          ...minimalOptions,
          virtualModuleDir: '__mf__virtual__app_name',
        }).virtualModuleDir
      ).toEqual('__mf__virtual__app_name');
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

// Windows temporarily needs this file, https://github.com/module-federation/vite/issues/68

const localSharedImportMap = {
  vue: async () => {
    let pkg = await import('__mf__virtual/viteViteHost-__prebuild__vue');
    return pkg;
  },
};
const localShared = {
  vue: {
    name: 'vue',
    version: '3.4.38',
    scope: ['default'],
    loaded: false,
    from: 'viteViteHost',
    async get() {
      localShared['vue'].loaded = true;
      const { vue: pkgDynamicImport } = localSharedImportMap;
      const res = await pkgDynamicImport();
      const exportModule = { ...res };
      // All npm packages pre-built by vite will be converted to esm
      Object.defineProperty(exportModule, '__esModule', {
        value: true,
        enumerable: false,
      });
      return function () {
        return exportModule;
      };
    },
    shareConfig: {
      singleton: false,
      requiredVersion: '^3.4.38',
    },
  },
};
export default localShared;

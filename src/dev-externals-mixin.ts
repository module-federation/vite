import { federationBuilder } from '@softarc/native-federation/build.js';
import { filterExternals } from './externals-skip-list';

// see: https://github.com/vitejs/vite/issues/6393#issuecomment-1006819717

export const devExternalsMixin = {
  enforce: 'pre',
  config(config) {
    config.optimizeDeps = {
      ...(config.optimizeDeps ?? {}),
      exclude: [
        ...(config.optimizeDeps?.exclude ?? []),
        ...filterExternals(federationBuilder.externals),
      ],
    };
  },
  configResolved(resolvedConfig) {
    const VALID_ID_PREFIX = `/@id/`;
    const reg = new RegExp(`${VALID_ID_PREFIX}(${federationBuilder.externals.join('|')})`, 'g');
    resolvedConfig.plugins.push({
      name: 'vite-plugin-ignore-static-import-replace-idprefix',
      transform: (code) => (reg.test(code) ? code.replace(reg, (m, s1) => s1) : code),
    });
  },
  resolveId: (id) => {
    if (filterExternals(federationBuilder.externals).includes(id)) {
      return { id, external: true };
    }
  },
} as any;

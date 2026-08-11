import type { UserConfig } from 'vite';

export default {
  name: 'alias-transform-plugin',
  config: (config: UserConfig) => {
    if (!config.resolve) config.resolve = {};
    if (!config.resolve.alias) config.resolve.alias = [];
    const { alias } = config.resolve;
    if (typeof alias === 'object' && !Array.isArray(alias)) {
      config.resolve.alias = Object.entries(alias).map(([find, replacement]) => ({
        find,
        replacement,
      }));
    }
  },
};

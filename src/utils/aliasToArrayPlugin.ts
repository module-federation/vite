import { UserConfig } from 'vite';

export interface Command {
  // define command properties here
}

export default {
  name: 'alias-transform-plugin',
  config: (config: UserConfig, { command }: { command: Command }) => {
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

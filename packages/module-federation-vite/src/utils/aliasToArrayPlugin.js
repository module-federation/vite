
module.exports = {
      name: 'alias-transform-plugin',
      config(config, { command }) {
        if (!config.resolve) config.resolve = {}
        if (!config.resolve.alias) config.resolve.alias = []
          const { alias } = config.resolve;
          // 处理 alias 是对象的情况
          if (typeof alias === 'object' && !Array.isArray(alias)) {
            config.resolve.alias = Object.entries(alias).map(([find, replacement]) => ({
              find,
              replacement
            }));
          }
      }
    }
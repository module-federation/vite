
module.exports = (shared) => ({
  name: 'normalizeBuild',
  config(config, { command }) {
    if (!config.build) config.build = {}
    if (!config.build.rollupOptions) config.build.rollupOptions = {}
    let {rollupOptions} = config.build
    if (!rollupOptions.output) rollupOptions.output = {}
    normalizeManualChunks(rollupOptions.output, shared)
  }
})
function normalizeManualChunks(output, shared = {}) {
  const pattern = new RegExp(`node_modules/(${Object.keys(shared).join("|")})/`)
  if (!output.manualChunks) output.manualChunks = {}
  const wrapManualChunks = (original) => (id, ...args) => {
    const [_, moduleName] = id.match(pattern) || []
    if (moduleName) {
      return moduleName
    }
    if (typeof original === 'function') {
      return original(id, ...args);
    }
    if (typeof original === "object" && original) {
      return original[id]
    }
  };
  output.manualChunks = wrapManualChunks(output.manualChunks)
}

module.exports = {
  name: 'normalizeOptimizeDeps',
  config(config, { command }) {
    let {optimizeDeps} = config
    if (!optimizeDeps) {
      config.optimizeDeps = {}
      optimizeDeps = config.optimizeDeps
    }
    if (!optimizeDeps.include) optimizeDeps.include = []
    if (!optimizeDeps.needsInterop) optimizeDeps.needsInterop = []
  }
}
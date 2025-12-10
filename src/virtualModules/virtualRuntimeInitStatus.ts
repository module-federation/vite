import VirtualModule from '../utils/VirtualModule';
// Use .mjs extension to ensure ESM treatment by bundlers
export const virtualRuntimeInitStatus = new VirtualModule('runtimeInit', '__mf_v__', '.mjs');
export function writeRuntimeInitStatus() {
  // Use globalThis singleton to ensure only one initPromise exists
  const globalKey = `__mf_init__${virtualRuntimeInitStatus.getImportId()}__`;
  // Generate ESM-compatible code to fix Vite 7/Rolldown compatibility
  // Use named ESM exports instead of module.exports for proper dynamic import support
  virtualRuntimeInitStatus.writeSync(`
    const globalKey = ${JSON.stringify(globalKey)}
    if (!globalThis[globalKey]) {
      let initResolve, initReject
      const initPromise = new Promise((re, rj) => {
        initResolve = re
        initReject = rj
      })
      globalThis[globalKey] = {
        initPromise,
        initResolve,
        initReject
      }
    }
    // Use ESM named exports instead of module.exports for compatibility with dynamic import()
    export const initPromise = globalThis[globalKey].initPromise
    export const initResolve = globalThis[globalKey].initResolve
    export const initReject = globalThis[globalKey].initReject
    `);
}

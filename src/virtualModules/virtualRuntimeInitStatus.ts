import VirtualModule from '../utils/VirtualModule';
export const virtualRuntimeInitStatus = new VirtualModule('runtimeInit');
export function writeRuntimeInitStatus() {
  // Use globalThis singleton to ensure only one initPromise exists
  const globalKey = `__mf_init__${virtualRuntimeInitStatus.getImportId()}__`;
  // This module is imported by both dev and build modes
  // We use a dual-export pattern that works with both CJS require() and ESM import
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
    // Dual exports: CJS for dev mode (require), ESM for build mode (import)
    module.exports = globalThis[globalKey]
    export const initPromise = globalThis[globalKey].initPromise
    export const initResolve = globalThis[globalKey].initResolve
    export const initReject = globalThis[globalKey].initReject
    `);
}

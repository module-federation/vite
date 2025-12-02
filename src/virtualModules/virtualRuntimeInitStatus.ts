import VirtualModule from '../utils/VirtualModule';
export const virtualRuntimeInitStatus = new VirtualModule('runtimeInit');
export function writeRuntimeInitStatus() {
  // Use globalThis singleton to ensure only one initPromise exists
  const globalKey = `__mf_init__${virtualRuntimeInitStatus.getImportId()}__`;
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
    module.exports = globalThis[globalKey]
    `);
}

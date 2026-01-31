import VirtualModule from '../utils/VirtualModule';
export const virtualRuntimeInitStatus = new VirtualModule('runtimeInit');
export function writeRuntimeInitStatus(command: string) {
  // Use globalThis singleton to ensure only one initPromise exists
  const globalKey = `__mf_init__${virtualRuntimeInitStatus.getImportId()}__`;

  if (command === 'build') {
    // Build mode: Use ESM syntax to fix Vite 7/Rolldown compatibility
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
      export const initPromise = globalThis[globalKey].initPromise
      export const initResolve = globalThis[globalKey].initResolve
      export const initReject = globalThis[globalKey].initReject
    `);
  } else {
    // Dev mode: Use CJS syntax for compatibility
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
}

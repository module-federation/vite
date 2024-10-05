import VirtualModule from '../utils/VirtualModule';
export const virtualRuntimeInitStatus = new VirtualModule('runtimeInit');
export function writeRuntimeInitStatus() {
  virtualRuntimeInitStatus.writeSync(`
    let initResolve, initReject
    const initPromise = new Promise((re, rj) => {
      initResolve = re
      initReject = rj
    })
    module.exports = {
      initPromise,
      initResolve,
      initReject
    }
    `);
}

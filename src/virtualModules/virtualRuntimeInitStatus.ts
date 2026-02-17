import VirtualModule from '../utils/VirtualModule';

export const virtualRuntimeInitStatus = new VirtualModule('runtimeInit');

export function writeRuntimeInitStatus(command: string) {
  const globalKey = `__mf_init__${virtualRuntimeInitStatus.getImportId()}__`;
  const exportStatement =
    command === 'build'
      ? `const { initPromise, initResolve, initReject } = globalThis[globalKey];
export { initPromise, initResolve, initReject };`
      : `module.exports = globalThis[globalKey];`;

  virtualRuntimeInitStatus.writeSync(`
const globalKey = ${JSON.stringify(globalKey)};
if (!globalThis[globalKey]) {
  let initResolve, initReject;
  const initPromise = new Promise((re, rj) => {
    initResolve = re;
    initReject = rj;
  });
  globalThis[globalKey] = {
    initPromise,
    initResolve,
    initReject,
  };
}
${exportStatement}
`);
}

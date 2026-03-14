import VirtualModule from '../utils/VirtualModule';

export const virtualRuntimeInitStatus = new VirtualModule('runtimeInit');

export function getRuntimeInitGlobalKey() {
  return `__mf_init__${virtualRuntimeInitStatus.getImportId()}__`;
}

export function getRuntimeInitBootstrapCode() {
  return `
const globalKey = ${JSON.stringify(getRuntimeInitGlobalKey())};
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
  if (typeof window === 'undefined') {
    initResolve({
      loadRemote: function() { return Promise.resolve(undefined); },
      loadShare: function() { return Promise.resolve(undefined); },
    });
  }
}
`;
}

export function writeRuntimeInitStatus(command: string) {
  const globalKey = getRuntimeInitGlobalKey();
  const exportStatement =
    command === 'build'
      ? `const { initPromise, initResolve, initReject } = globalThis[globalKey];
export { initPromise, initResolve, initReject };`
      : `module.exports = globalThis[globalKey];`;

  virtualRuntimeInitStatus.writeSync(`
${getRuntimeInitBootstrapCode()}
${exportStatement}
`);
}

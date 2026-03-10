import VirtualModule from '../utils/VirtualModule';

export const virtualRuntimeInitStatus = new VirtualModule('runtimeInit');

export function writeRuntimeInitStatus(command: string, force?: boolean) {
  const globalKey = `__mf_init__${virtualRuntimeInitStatus.getImportId()}__`;
  const exportStatement =
    command === 'build'
      ? `const { initPromise, initResolve, initReject } = globalThis[globalKey];
export { initPromise, initResolve, initReject };`
      : `module.exports = globalThis[globalKey];`;

  virtualRuntimeInitStatus.writeSync(
    `
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
  // In SSR (no window), resolve immediately with a stub runtime
  // so modules don't hang waiting for browser-only init
  if (typeof window === 'undefined') {
    initResolve({
      loadRemote: function() { return Promise.resolve(undefined); },
      loadShare: function() { return Promise.resolve(undefined); },
    });
  }
}
${exportStatement}
`,
    force
  );
}

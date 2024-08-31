import VirtualModule from "../utils/VirtualModule";

export const remoteVirtualModule = new VirtualModule("remoteModule")
export function writeRemote() {
  remoteVirtualModule.writeSync("")
}
export function generateRemotes(id: string, command: string): { code: string; map: null; syntheticNamedExports: string } {
  return {
    code: `
    import {loadRemote} from "@module-federation/runtime"
    const exportModule = await loadRemote(${JSON.stringify(id)})
    ${(command === "build" &&
        `
        export default 'default' in (exportModule || {}) ? exportModule.default : undefined
        export const __mf__dynamicExports = exportModule
        `
      ) || ""}
      ${(command !== "build" &&
        `
        export default exportModule
        `
      ) || ""}
  `,
    map: null,
    // TODO: vite dev mode invalid, use optimizeDeps.needsInterop
    syntheticNamedExports: '__mf__dynamicExports',
  };
}
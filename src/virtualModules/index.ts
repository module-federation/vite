import { writeHostAutoInit, writeLocalSharedImportMap } from './virtualRemoteEntry';
import { writeRuntimeInitStatus } from './virtualRuntimeInitStatus';

export {
  addUsedShares,
  generateLocalSharedImportMap,
  generateRemoteEntry,
  getHostAutoInitImportId,
  getHostAutoInitPath,
  getLocalSharedImportMapPath,
  getUsedShares,
  REMOTE_ENTRY_ID,
  writeLocalSharedImportMap,
} from './virtualRemoteEntry';

export {
  addUsedRemote,
  generateRemotes,
  getRemoteVirtualModule,
  getUsedRemotesMap,
  LOAD_REMOTE_TAG,
} from './virtualRemotes';

export {
  getLoadShareModulePath,
  getPreBuildLibImportId,
  LOAD_SHARE_TAG,
  PREBUILD_TAG,
  writeLoadShareModule,
  writePreBuildLibPath,
} from './virtualShared_preBuild';

export { generateExposes, VIRTUAL_EXPOSES } from './virtualExposes';

export { virtualRuntimeInitStatus } from './virtualRuntimeInitStatus';

export function initVirtualModules(command: string) {
  writeLocalSharedImportMap();
  writeHostAutoInit();
  writeRuntimeInitStatus(command);
}

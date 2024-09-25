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
} from './virtualRemotes';

export {
  getLoadShareModulePath,
  getPreBuildLibImportId,
  LOAD_SHARE_TAG,
  PREBUILD_TAG,
  writeLoadShareModule,
  writePreBuildLibPath,
} from './virtualShared_preBuild';

export { virtualRuntimeInitStatus } from './virtualRuntimeInitStatus';

export function initVirtualModules() {
  writeLocalSharedImportMap();
  writeHostAutoInit();
  writeRuntimeInitStatus();
}

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
  getRemoteEntryId,
  writeLocalSharedImportMap,
} from './virtualRemoteEntry';

export {
  addUsedRemote,
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

export { generateExposes } from './virtualExposes';

export function initVirtualModules(command: string, remoteEntryId?: string) {
  writeLocalSharedImportMap();
  writeHostAutoInit(remoteEntryId);
  writeRuntimeInitStatus(command);
}

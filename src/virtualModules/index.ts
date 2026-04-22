import { writeHostAutoInit, writeLocalSharedImportMap } from './virtualRemoteEntry';
import { writeRuntimeInitStatus } from './virtualRuntimeInitStatus';

export {
  addUsedShares,
  generateHostAutoInitCode,
  generateDirectSharedCacheSeedCode,
  generateLocalSharedImportMap,
  generateRemoteEntry,
  getHostAutoInitImportId,
  getHostAutoInitPath,
  getLocalSharedImportMapPath,
  getRemoteEntryId,
  getUsedShares,
  refreshHostAutoInit,
  writeHostAutoInit,
  writeLocalSharedImportMap,
} from './virtualRemoteEntry';

export {
  addUsedRemote,
  getRemoteVirtualModule,
  getUsedRemotesMap,
  LOAD_REMOTE_TAG,
} from './virtualRemotes';

export {
  getConcreteSharedImportSource,
  getLoadShareModulePath,
  getPreBuildLibImportId,
  getPreBuildShareItem,
  getProjectResolvedImportPath,
  getSharedImportSource,
  LOAD_SHARE_TAG,
  PREBUILD_TAG,
  writeLoadShareModule,
  writePreBuildLibPath,
} from './virtualShared_preBuild';

export { generateExposes, getExposesCssMapPlaceholder } from './virtualExposes';

export function initVirtualModules(command: string, remoteEntryId?: string) {
  writeLocalSharedImportMap();
  writeHostAutoInit(remoteEntryId, command);
  writeRuntimeInitStatus(command);
}

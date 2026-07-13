import {
  getHostAutoInitPath,
  writeHostAutoInit,
  writeLocalSharedImportMap,
} from './virtualRemoteEntry';
import { writeRuntimeInitStatus } from './virtualRuntimeInitStatus';

export {
  addUsedShares,
  generateHostAutoInitCode,
  generateLocalSharedImportMap,
  generateRemoteEntry,
  getHostAutoInitImportId,
  getHostAutoInitPath,
  getLocalSharedImportMapPath,
  getResolvedLocalSharedImportMapId,
  getRemoteEntryId,
  getUsedShares,
  refreshHostAutoInit,
  setLocalSharedImportMapInvalidator,
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
  addTreeShakingGraphQuery,
  getTreeShakingGraphToken,
  getTreeShakingSharedProviderImportId,
  getTreeShakingSharedProviderName,
  hasTreeShakingSharedProvider,
  LOAD_SHARE_TAG,
  PREBUILD_TAG,
  TREE_SHAKING_PROVIDER_TAG,
  TREE_SHAKING_GRAPH_QUERY,
  stripTreeShakingGraphQuery,
  writeLoadShareModule,
  writePreBuildLibPath,
  writeTreeShakingSharedProvider,
  refreshTreeShakingModules,
} from './virtualShared_preBuild';

export {
  getTreeShakingUsedExports,
  markTreeShakingPackageUnsafe,
  recordTreeShakingExports,
  resetTreeShakingExports,
  setTreeShakingBuildMode,
} from '../utils/treeShaking';

export { generateExposes, getExposesCssMapPlaceholder } from './virtualExposes';

export { setSsrRemotes } from './virtualRuntimeInitStatus';

export function initVirtualModules(command: string, remoteEntryId?: string, enableSsrInit = false) {
  writeLocalSharedImportMap();
  writeHostAutoInit(remoteEntryId, command);
  writeRuntimeInitStatus(command, enableSsrInit, getHostAutoInitPath());
}

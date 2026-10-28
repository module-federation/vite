import {
  getHostAutoInitPath,
  writeHostAutoInit,
  writeLocalSharedImportMap,
} from './virtualRemoteEntry';
import { getSsrRuntimeRemotes, writeRuntimeInitStatus } from './virtualRuntimeInitStatus';
import {
  getNormalizeModuleFederationOptions,
  type NormalizedModuleFederationOptions,
} from '../utils/normalizeModuleFederationOptions';

export {
  addConfiguredShare,
  addUsedShares,
  generateHostAutoInitCode,
  generateLocalSharedImportMap,
  generateRemoteEntry,
  getHostAutoInitPath,
  getLocalSharedImportMapPath,
  getResolvedLocalSharedImportMapId,
  getRemoteEntryId,
  getUsedShares,
  REMOTE_ENTRY_ID,
  refreshHostAutoInit,
  refreshPendingShares,
  getPendingSharesPath,
  isOwnedPendingSharesId,
  PENDING_SHARES_TAG,
  generatePendingSharesCode,
  writePendingShares,
  setLocalSharedImportMapInvalidator,
  writeHostAutoInit,
  writeLocalSharedImportMap,
} from './virtualRemoteEntry';

export {
  addUsedRemote,
  ensureUsedRemote,
  getRemoteVirtualModule,
  getUsedRemotesMap,
  markDynamicRemote,
  markStaticRemote,
  refreshRemoteModuleForEnvironment,
  LOAD_REMOTE_TAG,
} from './virtualRemotes';

export {
  getConcreteSharedImportSource,
  getLoadShareModulePath,
  getPreBuildLibImportId,
  getPreBuildShareItem,
  getProjectResolvedImportPath,
  getSharedImportSource,
  setWorkspaceEntryConditions,
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
  markTreeShakingPackageUnsafe,
  recordTreeShakingExports,
  resetTreeShakingExports,
  setTreeShakingBuildMode,
} from '../utils/treeShaking';

export { generateExposes, getExposesCssMapPlaceholder } from './virtualExposes';

export { setSsrRemotes } from './virtualRuntimeInitStatus';

export function initVirtualModules(
  command: string,
  remoteEntryId?: string,
  enableSsrInit = false,
  options?: NormalizedModuleFederationOptions
) {
  const resolvedOptions = options ?? getNormalizeModuleFederationOptions();
  writeLocalSharedImportMap(resolvedOptions);
  writeHostAutoInit(remoteEntryId, command, resolvedOptions);
  writeRuntimeInitStatus(
    command,
    enableSsrInit,
    getHostAutoInitPath(resolvedOptions),
    options,
    options ? getSsrRuntimeRemotes(options.remotes, options) : undefined
  );
}

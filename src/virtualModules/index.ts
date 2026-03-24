import type { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { writeHostAutoInit, writeLocalSharedImportMap } from './virtualRemoteEntry';
import { writeRuntimeInitStatus } from './virtualRuntimeInitStatus';

export {
  addUsedShares,
  generateLocalSharedImportMap,
  generateRemoteEntry,
  getHostAutoInitImportId,
  getHostAutoInitPath,
  getLocalSharedImportMapPath,
  getRemoteEntryId,
  getUsedShares,
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
  getSharedImportSource,
  LOAD_SHARE_TAG,
  PREBUILD_TAG,
  writeLoadShareModule,
  writePreBuildLibPath,
} from './virtualShared_preBuild';

export { generateExposes, getExposesCssMapPlaceholder } from './virtualExposes';

export function initVirtualModules(
  command: string,
  options: NormalizedModuleFederationOptions,
  remoteEntryId?: string
) {
  writeLocalSharedImportMap(options);
  writeHostAutoInit(remoteEntryId, options);
  writeRuntimeInitStatus(command, options);
}

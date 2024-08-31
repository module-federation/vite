import { writeHostAutoInit, writeWrapRemoteEntry } from "./virtualRemoteEntry";
import { writeRemote } from "./virtualRemotes";
import { writeLocalSharedImportMap } from "./virtualShared_preBuild";

export {
  generateRemoteEntry, getHostAutoInitImportId,
  getHostAutoInitPath, getWrapRemoteEntryImportId,
  getWrapRemoteEntryPath, REMOTE_ENTRY_ID
} from "./virtualRemoteEntry";

export {
  generateRemotes, remoteVirtualModule
} from "./virtualRemotes";

export {
  addShare, generateLocalSharedImportMap, getLoadShareModulePath, getLocalSharedImportMapPath, getPreBuildLibImportId, LOAD_SHARE_TAG, localSharedImportMapModule, PREBUILD_TAG, writeLoadShareModule, writeLocalSharedImportMap, writePreBuildLibPath
} from "./virtualShared_preBuild";

export function initVirtualModules() {
  writeLocalSharedImportMap()
  writeWrapRemoteEntry()
  writeHostAutoInit()
  writeRemote()
}
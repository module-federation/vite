/**
 * Even the resolveId hook cannot interfere with vite pre-build,
 * and adding query parameter virtual modules will also fail.
 * You can only proxy to the real file through alias
 */
/**
* shared will be proxied:
* 1. __prebuild__: export shareModule (pre-built source code of modules such as vue, react, etc.)
* 2. __loadShare__: load shareModule (mfRuntime.loadShare('vue'))
*/
import { ShareItem } from "../utils/normalizeModuleFederationOptions";
export declare const PREBUILD_TAG = "__prebuild__";
export declare function writePreBuildLibPath(pkg: string): void;
export declare function getPreBuildLibImportId(pkg: string): string;
export declare const LOAD_SHARE_TAG = "__loadShare__";
export declare function getLoadShareModulePath(pkg: string): string;
export declare function writeLoadShareModule(pkg: string, shareItem: ShareItem, command: string): void;

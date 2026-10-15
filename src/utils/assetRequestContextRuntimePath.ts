import { resolveOwnEntryPath } from './packageUtils';

const ASSET_REQUEST_CONTEXT_RUNTIME = '@module-federation/vite/assetRequestContext';
let assetRequestContextRuntimePath: string | undefined;

/** Import path of the assetRequestContext runtime that remote entries bundle. */
export function getAssetRequestContextRuntimePath(): string {
  assetRequestContextRuntimePath ??= resolveOwnEntryPath(ASSET_REQUEST_CONTEXT_RUNTIME, [
    new URL('./utils/assetRequestContext.js', import.meta.url),
    new URL('./assetRequestContext.ts', import.meta.url),
  ]);
  return assetRequestContextRuntimePath;
}

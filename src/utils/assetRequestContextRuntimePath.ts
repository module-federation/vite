import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { normalizePathForImport } from './buildPaths';
import { resolveImportPath } from './packageUtils';

const ASSET_REQUEST_CONTEXT_RUNTIME = '@module-federation/vite/assetRequestContext';
let assetRequestContextRuntimePath: string | undefined;

// The source/companion files beside this module, for dev/test before `lib/` exists.
function getCompanionPaths(): string[] {
  return ['./utils/assetRequestContext.js', './assetRequestContext.ts']
    .map((rel) => fileURLToPath(new URL(rel, import.meta.url)))
    .filter((candidate) => existsSync(candidate))
    .map(normalizePathForImport);
}

/** Import path of the assetRequestContext runtime that remote entries bundle. */
export function getAssetRequestContextRuntimePath(): string {
  if (assetRequestContextRuntimePath) return assetRequestContextRuntimePath;
  try {
    assetRequestContextRuntimePath = normalizePathForImport(
      resolveImportPath(ASSET_REQUEST_CONTEXT_RUNTIME)
    );
  } catch {
    assetRequestContextRuntimePath = getCompanionPaths()[0] ?? ASSET_REQUEST_CONTEXT_RUNTIME;
  }
  return assetRequestContextRuntimePath;
}

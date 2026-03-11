import { OutputBundle } from 'rollup';

/**
 * Resolve the local alias for a non-inlineable proxy binding.
 * If Rollup's deconflict renamed the alias but didn't update references
 * in the code body, fall back to proxyLocal so they stay in sync.
 */
export function resolveProxyAlias(
  binding: { imported: string; local: string },
  proxyLocal: string,
  code: string,
  fullImport: string
): { imported: string; local: string } {
  const codeWithoutImport = code.replace(fullImport, '');
  const escapedLocal = binding.local.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const localUsedInCode = new RegExp(`\\b${escapedLocal}\\b`).test(codeWithoutImport);
  return {
    imported: binding.imported,
    local: localUsedInCode ? binding.local : proxyLocal,
  };
}

export function findRemoteEntryFile(filename: string, bundle: OutputBundle) {
  for (const [_, fileData] of Object.entries(bundle)) {
    if (
      filename.replace(/[\[\]]/g, '_').replace(/\.[^/.]+$/, '') === fileData.name ||
      fileData.name === 'remoteEntry'
    ) {
      return fileData.fileName; // We can return early since we only need to find remoteEntry once
    }
  }
}

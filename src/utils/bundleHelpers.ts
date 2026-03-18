import { OutputBundle, OutputChunk } from 'rollup';

/**
 * Resolve the local alias for a non-inlineable proxy binding.
 * If Rollup's deconflict renamed the alias but didn't update references
 * in the code body, fall back to proxyLocal so they stay in sync.
 */
export function resolveProxyAlias(
  binding: { imported: string; local: string },
  proxyLocal: string,
  code: string,
  fullImport: string,
  claimedLocals: Set<string> = new Set()
): { imported: string; local: string } {
  const codeWithoutImport = code.replace(fullImport, '');
  const escapedLocal = binding.local.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const localUsedInCode = new RegExp(`\\b${escapedLocal}\\b`).test(codeWithoutImport);
  const claimedImportLocals = new Set<string>();
  const importRe = /import\s*\{([^}]+)\}\s*from\s*["'][^"']+["']\s*;?/g;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(codeWithoutImport)) !== null) {
    for (const spec of match[1].split(',')) {
      const parts = spec.trim().split(/\s+as\s+/);
      claimedImportLocals.add((parts[1] || parts[0]).trim());
    }
  }
  const canUseProxyLocal =
    !localUsedInCode && !claimedLocals.has(proxyLocal) && !claimedImportLocals.has(proxyLocal);
  const local = canUseProxyLocal ? proxyLocal : binding.local;

  return {
    imported: binding.imported,
    local,
  };
}

/**
 * Remove side-effect imports of loadShare chunks from non-loadShare chunks.
 *
 * Rolldown adds bare `import"./loadShare_chunk.js"` to shared bundles.
 * These create circular TLA dependencies: loadShare TLA → loadShare()
 * → import(sharedBundle) → sharedBundle waits for loadShare TLA → deadlock.
 */
export function removeSideEffectLoadShareImports(
  bundle: Record<string, { type: string; code?: string; fileName?: string }>,
  loadShareTag: string
): void {
  const loadShareBaseNames = new Set<string>();
  for (const fileName of Object.keys(bundle)) {
    if (fileName.includes(loadShareTag)) {
      loadShareBaseNames.add(fileName.split('/').pop()!);
    }
  }
  if (loadShareBaseNames.size === 0) return;

  for (const [fileName, chunk] of Object.entries(bundle)) {
    if (chunk.type !== 'chunk') continue;
    if (fileName.includes(loadShareTag)) continue;

    for (const baseName of loadShareBaseNames) {
      const sideEffect = `import"./${baseName}";`;
      if (chunk.code!.includes(sideEffect)) {
        chunk.code = chunk.code!.replaceAll(sideEffect, '');
      }
    }
  }
}

/**
 * Eagerly evaluate lazy-init in loadShare chunks.
 *
 * Rolldown wraps loadShare modules with `var X = n(async () => {...})`.
 * The exports are only populated after X() is called. Without eager
 * evaluation, importing modules access undefined exports.
 * Adding `await X();` at module scope converts the lazy pattern to
 * browser-level TLA, ensuring exports are set before dependents run.
 */
export function eagerEvaluateLazyInit(
  bundle: Record<string, { type: string; code?: string; fileName?: string }>,
  loadShareTag: string
): void {
  const lazyInitPattern = /(\w+)\s*=\s*\w+\(\(\s*async\s*\(\s*\)\s*=>\s*\{/;
  for (const [fileName, chunk] of Object.entries(bundle)) {
    if (chunk.type !== 'chunk') continue;
    if (!fileName.includes(loadShareTag)) continue;

    const match = lazyInitPattern.exec(chunk.code!);
    if (!match) continue;

    const lazyVar = match[1];
    const exportIdx = chunk.code!.lastIndexOf('export{');
    if (exportIdx < 0) continue;

    chunk.code =
      chunk.code!.slice(0, exportIdx) + `await ${lazyVar}();` + chunk.code!.slice(exportIdx);
  }
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

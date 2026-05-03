import type { OutputBundleItem } from './cssModuleHelpers';

type BundleChunkLike = { type: 'chunk'; fileName: string; code: string };
type BundleAssetLike = { type: 'asset'; fileName: string };
type BundleLike = Record<string, BundleChunkLike | BundleAssetLike>;
type ProxyChunkInfo = { code: string; fileName: string };
type SystemProxyInfo = {
  loadShareDep: string;
  exportMap: Record<
    string,
    { type: 'helper'; code: string } | { type: 'reexport'; exportName: string }
  >;
};

function isOutputChunk(chunk: BundleLike[string]): chunk is BundleChunkLike {
  return chunk.type === 'chunk';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getProxyBaseName(fileName: string): string {
  return fileName
    .replace(/^.*\//, '')
    .replace(/\.js$/, '')
    .replace(/-[A-Za-z0-9_-]+$/, '');
}

function extractFunctionDeclaration(code: string, functionName: string): string | undefined {
  const funcRe = new RegExp(`function\\s+${functionName}\\s*\\([^)]*\\)\\s*\\{`);
  const funcStart = code.search(funcRe);
  if (funcStart < 0) return;

  let depth = 0;
  for (let i = code.indexOf('{', funcStart); i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') {
      depth--;
      if (depth === 0) return code.slice(funcStart, i + 1);
    }
  }
}

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

export function collectLoadShareProxyChunks(
  bundle: BundleLike,
  loadShareTag: string
): Map<string, ProxyChunkInfo> {
  const proxyChunks = new Map<string, ProxyChunkInfo>();
  for (const [fileName, chunk] of Object.entries(bundle)) {
    if (!isOutputChunk(chunk)) continue;
    if (fileName.includes(loadShareTag) && fileName.includes('commonjs-proxy')) {
      proxyChunks.set(fileName, { code: chunk.code, fileName });
    }
  }
  return proxyChunks;
}

export function collectSystemProxyInfos(
  proxyChunks: Map<string, ProxyChunkInfo>,
  loadShareTag: string
): Map<string, SystemProxyInfo> {
  const systemProxyInfo = new Map<string, SystemProxyInfo>();

  for (const [proxyFileName, proxyInfo] of Array.from(proxyChunks.entries())) {
    const depsMatch = proxyInfo.code.match(/System\.register\(\[([\s\S]*?)\]/);
    if (!depsMatch) continue;

    const deps = Array.from(depsMatch[1].matchAll(/["']([^"']+)["']/g)).map((m) => m[1]);
    const loadShareDep = deps.find(
      (dep) => dep.includes(loadShareTag) && !dep.includes('commonjs-proxy')
    );
    if (!loadShareDep) continue;

    const loadShareBindings: Record<string, string> = {};
    for (const m of proxyInfo.code.matchAll(
      /([A-Za-z_$][\w$]*)\s*=\s*module\d+\.([A-Za-z_$][\w$]*)/g
    )) {
      loadShareBindings[m[1]] = m[2];
    }

    const exportMap: SystemProxyInfo['exportMap'] = {};
    const objectExportMatch = proxyInfo.code.match(/exports\(\s*\{([\s\S]*?)\}\s*\)/);
    if (objectExportMatch) {
      for (const m of objectExportMatch[1].matchAll(
        /([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)/g
      )) {
        const [, exported, local] = m;
        const funcBody = extractFunctionDeclaration(proxyInfo.code, local);
        if (funcBody) exportMap[exported] = { type: 'helper', code: funcBody };
      }
    }

    for (const m of proxyInfo.code.matchAll(/exports\(\s*["']([^"']+)["']\s*,([\s\S]*?)\);/g)) {
      const exported = m[1];
      const expression = m[2];
      for (const [local, exportName] of Object.entries(loadShareBindings)) {
        if (new RegExp(`\\b${local}\\b`).test(expression)) {
          exportMap[exported] = { type: 'reexport', exportName };
          break;
        }
      }
    }

    if (Object.keys(exportMap).length > 0) {
      systemProxyInfo.set(proxyFileName, { loadShareDep, exportMap });
    }
  }

  return systemProxyInfo;
}

export function rewriteEsmProxyConsumers(
  code: string,
  proxyChunks: Map<string, ProxyChunkInfo>
): string {
  let nextCode = code;
  const claimedLocals = new Set<string>();

  for (const [proxyFileName, proxyInfo] of Array.from(proxyChunks.entries())) {
    const proxyBaseName = getProxyBaseName(proxyFileName);
    const importRe = new RegExp(
      `import\\s*\\{([^}]+)\\}\\s*from\\s*["']([^"']*${escapeRegExp(proxyBaseName)}[^"']*)["']\\s*;?`
    );
    const importMatch = importRe.exec(nextCode);
    if (!importMatch) continue;

    const fullImport = importMatch[0];
    const bindings = importMatch[1].split(',').map((s) => {
      const parts = s.trim().split(/\s+as\s+/);
      return {
        imported: parts[0].trim(),
        local: (parts[1] || parts[0]).trim(),
      };
    });

    const exportMapMatch = proxyInfo.code.match(/export\s*\{([^}]+)\}/);
    if (!exportMapMatch) continue;

    const exportMap: Record<string, string> = {};
    for (const entry of exportMapMatch[1].split(',')) {
      const parts = entry.trim().split(/\s+as\s+/);
      if (parts.length === 2) exportMap[parts[1].trim()] = parts[0].trim();
    }

    const inlineable: Array<{ local: string; funcBody: string }> = [];
    const nonInlineable: Array<{ imported: string; local: string }> = [];
    const pendingLocals = new Set(bindings.map((binding) => binding.local));

    for (const b of bindings) {
      pendingLocals.delete(b.local);
      const proxyLocal = exportMap[b.imported];
      if (!proxyLocal) {
        claimedLocals.add(b.local);
        nonInlineable.push(b);
        continue;
      }

      const funcBody = extractFunctionDeclaration(proxyInfo.code, proxyLocal);
      if (funcBody) {
        inlineable.push({
          local: b.local,
          funcBody: funcBody.replace(
            new RegExp(`function\\s+${proxyLocal}\\s*\\(`),
            `function ${b.local}(`
          ),
        });
        claimedLocals.add(b.local);
      } else {
        const unavailableLocals = new Set(claimedLocals);
        pendingLocals.forEach((local) => unavailableLocals.add(local));
        const resolvedBinding = resolveProxyAlias(
          b,
          proxyLocal,
          nextCode,
          fullImport,
          unavailableLocals
        );
        claimedLocals.add(resolvedBinding.local);
        nonInlineable.push(resolvedBinding);
      }
    }

    const hasRenamedAlias = nonInlineable.some(
      (b) => bindings.find((ob) => ob.imported === b.imported)?.local !== b.local
    );
    if (inlineable.length === 0 && !hasRenamedAlias) continue;

    let replacement = '';
    if (nonInlineable.length > 0) {
      const kept = nonInlineable
        .map((b) => (b.imported === b.local ? b.imported : `${b.imported} as ${b.local}`))
        .join(',');
      replacement = `import{${kept}}from"${importMatch[2]}";`;
    }
    replacement += inlineable.map((f) => f.funcBody).join('');

    nextCode = nextCode.replace(fullImport, () => replacement);
  }

  return nextCode;
}

export function rewriteSystemProxyConsumers(
  code: string,
  systemProxyInfo: Map<string, SystemProxyInfo>
): string {
  if (!code.includes('System.register(')) return code;

  let nextCode = code;
  for (const [proxyFileName, proxyInfo] of Array.from(systemProxyInfo.entries())) {
    const proxyBaseName = getProxyBaseName(proxyFileName);
    const depRe = new RegExp(`["']([^"']*${escapeRegExp(proxyBaseName)}[^"']*)["']`);
    const depMatch = depRe.exec(nextCode);
    if (!depMatch) continue;

    let setterIndex = 0;
    const depListMatch = nextCode.match(/System\.register\(\[([\s\S]*?)\]/);
    if (depListMatch) {
      const deps = Array.from(depListMatch[1].matchAll(/["']([^"']+)["']/g)).map((m) => m[1]);
      setterIndex = deps.findIndex((dep) => dep.includes(proxyBaseName));
    }
    if (setterIndex < 0) continue;

    const settersStart = nextCode.indexOf('setters: [');
    if (settersStart < 0) continue;

    const setterMatches = Array.from(
      nextCode.slice(settersStart).matchAll(/\((module\d+)\)\s*=>\s*\{([\s\S]*?)\}/g)
    );
    const setterMatch = setterMatches[setterIndex];
    if (!setterMatch) continue;

    const [fullSetter, moduleLocal, setterBody] = setterMatch;
    const helpersToInline: string[] = [];
    const nextSetterBody = setterBody.replace(
      new RegExp(`([A-Za-z_$][\\w$]*)\\s*=\\s*${moduleLocal}\\.([A-Za-z_$][\\w$]*);?`, 'g'),
      (assignment, local, imported) => {
        const mapped = proxyInfo.exportMap[imported];
        if (!mapped) return assignment;

        if (mapped.type === 'helper') {
          helpersToInline.push(
            mapped.code.replace(new RegExp(`function\\s+${imported}\\s*\\(`), `function ${local}(`)
          );
          return '';
        }

        return `${local} = ${moduleLocal}.${mapped.exportName};`;
      }
    );

    if (nextSetterBody === setterBody && helpersToInline.length === 0) continue;

    const nextSetter = fullSetter.replace(setterBody, () => nextSetterBody);
    nextCode = nextCode.replace(fullSetter, () => nextSetter);
    nextCode = nextCode.replace(depMatch[0], JSON.stringify(proxyInfo.loadShareDep));
    if (helpersToInline.length > 0) {
      nextCode = nextCode.replace('execute: (function() {', () => {
        return `execute: (function() {${helpersToInline.join('')}`;
      });
    }
  }

  return nextCode;
}

export function findRemoteEntryFile(filename: string, bundle: Record<string, OutputBundleItem>) {
  for (const [_, fileData] of Object.entries(bundle)) {
    if (
      filename.replace(/[\[\]]/g, '_').replace(/\.[^/.]+$/, '') === fileData.name ||
      fileData.name === 'remoteEntry'
    ) {
      return fileData.fileName; // We can return early since we only need to find remoteEntry once
    }
  }
}

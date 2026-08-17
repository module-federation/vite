import { isIdentifierReferenced } from './bundleHelpers';

const FEDERATION_CONTROL_CHUNK_HINTS = [
  'hostInit',
  'virtualExposes',
  'localSharedImportMap',
] as const;

export function stripEmptyPreloadCalls(code: string): string {
  // Not `\w+`: that skips the `$`-prefixed aliases minifiers produce, leaving
  // those imports unprocessed.
  const helperImportRegex =
    /import\s*\{\s*_\s*as\s*([A-Za-z_$][\w$]*)\s*\}\s*from\s*["'][^"']+["']\s*;?/g;
  const helperAliases: string[] = [];
  let helperImportMatch: RegExpExecArray | null;
  while ((helperImportMatch = helperImportRegex.exec(code)) !== null) {
    helperAliases.push(helperImportMatch[1]);
  }
  let nextCode = code;

  for (const alias of helperAliases) {
    const marker = `${alias}(()=>`;
    let start = nextCode.indexOf(marker);

    while (start !== -1) {
      const exprStart = start + marker.length;
      let depth = 0;
      let cursor = exprStart;
      let replacementEnd = -1;

      while (cursor < nextCode.length) {
        const char = nextCode[cursor];
        if (char === '(') depth++;
        else if (char === ')') {
          depth--;
          if (depth < 0) break;
        } else if (depth === 0 && nextCode.startsWith(',[],import.meta.url)', cursor)) {
          replacementEnd = cursor;
          break;
        }
        cursor++;
      }

      if (replacementEnd === -1) {
        start = nextCode.indexOf(marker, start + marker.length);
        continue;
      }

      const expression = nextCode.slice(exprStart, replacementEnd);
      nextCode =
        nextCode.slice(0, start) +
        expression +
        nextCode.slice(replacementEnd + ',[],import.meta.url)'.length);

      start = nextCode.indexOf(marker, start + expression.length);
    }
  }

  nextCode = nextCode.replace(/import\s*["'][^"']*__loadShare__[^"']*["']\s*;?/g, '');

  nextCode = nextCode.replace(helperImportRegex, (statement, local) => {
    // Only drop the import when the binding is not referenced anywhere else.
    // Testing for a call (`local(`) is not enough: `import { _ as x } from '...'` is
    // also how Rollup renders a namespace import that crosses a chunk boundary, and
    // such a binding is usually referenced as a plain value (e.g. `return x;`) rather
    // than called. Dropping that import leaves an undeclared free identifier behind,
    // which throws at runtime while the build still exits successfully.
    return isIdentifierReferenced(local, nextCode.replace(statement, '')) ? statement : '';
  });

  return nextCode;
}

export function isFederationControlChunk(fileName: string, filename: string): boolean {
  return (
    fileName.includes(filename) ||
    FEDERATION_CONTROL_CHUNK_HINTS.some((hint) => fileName.includes(hint))
  );
}

export function sanitizeFederationControlChunk(
  code: string,
  fileName: string,
  filename: string
): string {
  let nextCode = stripEmptyPreloadCalls(code);

  if (fileName.includes('localSharedImportMap')) {
    const remoteEntryImportRegex = new RegExp(
      `import\\s*["'][^"']*${filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']\\s*;?`,
      'g'
    );
    nextCode = nextCode.replace(remoteEntryImportRegex, '');
  }

  return nextCode;
}

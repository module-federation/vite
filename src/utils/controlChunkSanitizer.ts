const FEDERATION_CONTROL_CHUNK_HINTS = [
  'hostInit',
  'virtualExposes',
  'localSharedImportMap',
] as const;

export function stripEmptyPreloadCalls(code: string): string {
  const helperImportRegex = /import\s*\{\s*_\s*as\s*(\w+)\s*\}\s*from\s*["'][^"']+["']\s*;?/g;
  const helperAliases = [...code.matchAll(helperImportRegex)].map((match) => match[1]);
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
        else if (char === ')') depth--;
        else if (depth === 0 && nextCode.startsWith(',[],import.meta.url)', cursor)) {
          replacementEnd = cursor;
          break;
        }
        cursor++;
      }

      if (replacementEnd === -1) break;

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
    const helperCallRegex = new RegExp(`\\b${local}\\s*\\(`);
    return helperCallRegex.test(nextCode.replace(statement, '')) ? statement : '';
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

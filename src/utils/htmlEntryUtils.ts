import { createCodePositionMap } from './codePositionMap';

export interface ModuleImportDescriptor {
  kind: 'static' | 'dynamic';
  syntax: 'import' | 'require';
  source: string;
  typeOnly: boolean;
}

function isTypeOnlyClause(clause: string): boolean {
  const normalized = clause.trim();
  const declarationTypeOnly = normalized.match(/^type\b([\s\S]*)$/)?.[1].trim();
  if (declarationTypeOnly !== undefined) {
    return declarationTypeOnly.length > 0 && !declarationTypeOnly.startsWith(',');
  }

  const namedSpecifiers = normalized.match(/^\{([\s\S]*)\}$/)?.[1];
  if (!namedSpecifiers) return false;

  const specifiers = namedSpecifiers
    .split(',')
    .map((specifier) => specifier.trim())
    .filter(Boolean);
  // `type` alone (or `type as X`) imports a runtime binding literally named
  // `type`, not a type-only specifier — the `type` modifier always needs a
  // following identifier (`type Foo`).
  return (
    specifiers.length > 0 &&
    specifiers.every((specifier) => /^type\s+(?!as(?:\s|$))\S/.test(specifier))
  );
}

/**
 * Finds module imports while ignoring comments, strings, and regular expressions.
 * The descriptor keeps enough information for callers to distinguish runtime
 * static imports from type-only imports without introducing a parser dependency.
 */
export function findModuleImportDescriptors(code: string): ModuleImportDescriptor[] {
  const codePositions = createCodePositionMap(code);
  const descriptors: ModuleImportDescriptor[] = [];
  const staticFromPattern = /\b(?:import|export)\s+([\s\S]*?)\s+from\s*(["'])([^"']+)\2/g;
  const dynamicPattern = /\bimport\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)?(["'])([^"']+)\1\s*\)/g;
  const requirePattern = /\brequire\s*\(\s*(["'])([^"']+)\1\s*\)/g;
  const sideEffectPattern = /\bimport\s*(["'])([^"']+)\1/g;

  let match: RegExpExecArray | null;
  while ((match = staticFromPattern.exec(code))) {
    if (!codePositions[match.index!]) {
      staticFromPattern.lastIndex = match.index! + 1;
      continue;
    }
    descriptors.push({
      kind: 'static',
      syntax: 'import',
      source: match[3],
      typeOnly: isTypeOnlyClause(match[1]),
    });
  }

  for (const match of code.matchAll(dynamicPattern)) {
    if (!codePositions[match.index!]) continue;
    descriptors.push({ kind: 'dynamic', syntax: 'import', source: match[2], typeOnly: false });
  }

  for (const match of code.matchAll(requirePattern)) {
    if (!codePositions[match.index!]) continue;
    descriptors.push({ kind: 'dynamic', syntax: 'require', source: match[2], typeOnly: false });
  }

  for (const match of code.matchAll(sideEffectPattern)) {
    if (!codePositions[match.index!]) continue;
    descriptors.push({ kind: 'static', syntax: 'import', source: match[2], typeOnly: false });
  }

  return descriptors;
}

export function findModuleImportSources(code: string): string[] {
  return Array.from(
    new Set(
      findModuleImportDescriptors(code)
        .filter(({ syntax, typeOnly }) => syntax === 'import' && !typeOnly)
        .map(({ source }) => source)
    )
  );
}

export function sanitizeDevEntryPath(devEntryPath: string): string {
  // devEntryPath is already root-relative at this point (built in pluginAddEntry),
  // just normalize any remaining backslashes for use in HTML/URLs.
  return devEntryPath.replace(/\\\\?/g, '/');
}

/**
 * Rewrites entry module script tags to point at an external wrapper module.
 * The wrapper can then sequence federation init before the app entry without
 * relying on CSP-breaking inline `<script type="module">`.
 */
export function rewriteEntryScripts(
  html: string,
  createProxySrc: (entrySrc: string) => string
): string {
  const scriptTagRegex =
    /<script\b(?=[^>]*\btype=["']module["'])(?=[^>]*\bsrc=["'][^"']+["'])([^>]*)>/gi;

  return html.replace(scriptTagRegex, (match, attrs) => {
    if (/\svite-ignore(?:\s|=|\/|$)/i.test(attrs)) return match;
    const srcMatch = attrs.match(/\bsrc=["']([^"']+)["']/i);
    if (!srcMatch) return match;
    const originalSrc = srcMatch[1];
    if (originalSrc.includes('@vite/client')) return match;
    const proxySrc = createProxySrc(originalSrc);
    return match.replace(srcMatch[0], `src=${JSON.stringify(proxySrc)}`);
  });
}

export function injectEntryScript(html: string, initSrc: string): string {
  const src = sanitizeDevEntryPath(initSrc);
  return html.replace('<head>', `<head><script type="module" src=${JSON.stringify(src)}></script>`);
}

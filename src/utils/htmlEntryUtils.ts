import { createCodePositionMap } from './codePositionMap';

export interface ModuleImportDescriptor {
  kind: 'static' | 'dynamic';
  syntax: 'import' | 'require';
  source: string;
  typeOnly: boolean;
}

const IDENTIFIER = String.raw`[$_\p{ID_Start}][$_\u200C\u200D\p{ID_Continue}]*`;
const NAMED_SPECIFIERS = String.raw`\{[^{}]*\}`;
const NAMESPACE_SPECIFIER = String.raw`\*\s*as\s+${IDENTIFIER}`;
const IMPORT_CLAUSE = String.raw`(?:(?<importType>type)\s+)?(?<importClause>${NAMESPACE_SPECIFIER}|${NAMED_SPECIFIERS}|${IDENTIFIER}(?:\s*,\s*(?:${NAMESPACE_SPECIFIER}|${NAMED_SPECIFIERS}))?)`;
const EXPORT_CLAUSE = String.raw`(?:(?<exportType>type)\s+)?(?<exportClause>\*(?:\s*as\s+(?:${IDENTIFIER}|"[^"]*"|'[^']*'))?|${NAMED_SPECIFIERS})`;
const SPECIFIER = String.raw`(?<quote>["'])(?<source>[^"'\r\n]*)\k<quote>`;
// `import`/`require` preceded by `.`, `$`, or a word char is a member access or
// part of a longer identifier, not the keyword.
const KEYWORD_BOUNDARY = String.raw`(?<![.$\w])`;

// Whitespace after the keyword is optional when a `{` or `*` follows (minified code).
const KEYWORD_GAP = String.raw`(?:\s+|(?=[{*]))`;

const STATIC_PATTERN = new RegExp(
  String.raw`${KEYWORD_BOUNDARY}(?:import${KEYWORD_GAP}${IMPORT_CLAUSE}|export${KEYWORD_GAP}${EXPORT_CLAUSE})\s*from\s*${SPECIFIER}`,
  'gud'
);
const DYNAMIC_PATTERN = new RegExp(
  String.raw`${KEYWORD_BOUNDARY}import\s*\(\s*${SPECIFIER}`,
  'gud'
);
const REQUIRE_PATTERN = new RegExp(
  String.raw`${KEYWORD_BOUNDARY}require\s*\(\s*${SPECIFIER}\s*\)`,
  'gud'
);
const SIDE_EFFECT_PATTERN = new RegExp(String.raw`${KEYWORD_BOUNDARY}import\s*${SPECIFIER}`, 'gud');

/**
 * Returns `code` with every non-code region blanked out to spaces so that
 * regexes can run against real syntax only. String literals keep their
 * delimiters (with a blank interior) so import specifiers stay locatable;
 * comments, template literals, and regular expressions vanish entirely.
 * The result has the same length as `code`, so match indices map back 1:1.
 */
function blankNonCode(code: string): string {
  const codePositions = createCodePositionMap(code);
  const chars = code.split('');
  let index = 0;
  while (index < code.length) {
    if (codePositions[index]) {
      index++;
      continue;
    }
    const start = index;
    while (index < code.length && !codePositions[index]) index++;
    const quote = code[start];
    const isString =
      (quote === '"' || quote === "'") && index - start >= 2 && code[index - 1] === quote;
    for (let position = start; position < index; position++) {
      const keep = isString && (position === start || position === index - 1);
      chars[position] = keep ? quote : code[position] === '\n' ? '\n' : ' ';
    }
  }
  return chars.join('');
}

function isTypeOnlyNamedClause(clause: string): boolean {
  const namedSpecifiers = clause.trim().match(/^\{([\s\S]*)\}$/)?.[1];
  if (namedSpecifiers === undefined) return false;

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

function readSource(code: string, match: RegExpMatchArray): string | undefined {
  const range = match.indices?.groups?.source;
  if (!range) return undefined;
  const source = code.slice(range[0], range[1]);
  return source.length > 0 ? source : undefined;
}

/**
 * Finds module imports while ignoring comments, strings, and regular expressions.
 * The descriptor keeps enough information for callers to distinguish runtime
 * static imports from type-only imports without introducing a parser dependency.
 *
 * Matching runs against a blanked copy of the code (see `blankNonCode`), so an
 * `import` inside a comment or string can never match, comments inside a
 * statement never change its classification, and a clause can never span
 * multiple statements.
 */
export function findModuleImportDescriptors(code: string): ModuleImportDescriptor[] {
  const blanked = blankNonCode(code);
  const descriptors: ModuleImportDescriptor[] = [];

  for (const match of blanked.matchAll(STATIC_PATTERN)) {
    const source = readSource(code, match);
    if (!source) continue;
    const groups = match.groups!;
    const typeOnly =
      groups.importType !== undefined ||
      groups.exportType !== undefined ||
      isTypeOnlyNamedClause(groups.importClause ?? groups.exportClause ?? '');
    descriptors.push({ kind: 'static', syntax: 'import', source, typeOnly });
  }

  for (const match of blanked.matchAll(DYNAMIC_PATTERN)) {
    const source = readSource(code, match);
    if (source) descriptors.push({ kind: 'dynamic', syntax: 'import', source, typeOnly: false });
  }

  for (const match of blanked.matchAll(REQUIRE_PATTERN)) {
    const source = readSource(code, match);
    if (source) descriptors.push({ kind: 'dynamic', syntax: 'require', source, typeOnly: false });
  }

  for (const match of blanked.matchAll(SIDE_EFFECT_PATTERN)) {
    const source = readSource(code, match);
    if (source) descriptors.push({ kind: 'static', syntax: 'import', source, typeOnly: false });
  }

  return descriptors;
}

/**
 * Returns the JavaScript/TypeScript portion of a module for import scanning.
 * Vue and Svelte single-file components only contribute their `<script>`
 * blocks so template markup and styles are never misread as code.
 */
export function getScannableModuleSource(id: string, code: string): string {
  if (!/\.(?:vue|svelte)(?:\?|$)/.test(id)) return code;
  const blocks: string[] = [];
  for (const match of code.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script(?:\s[^>]*)?>/gi)) {
    blocks.push(match[1]);
  }
  return blocks.join('\n');
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
  const script = `<script type="module" src=${JSON.stringify(src)}></script>`;
  // Match the first `<head>` even when it has attributes or differs in case.
  // `\b` keeps `<header>` from being treated as a head tag. The original tag
  // is preserved so exact `<head>` still becomes `<head><script…>`.
  return html.replace(/<head\b[^>]*>/i, (openTag) => `${openTag}${script}`);
}

import * as vite from 'vite';

type ImportUsage = {
  readonly source: string;
  // null requires all exports; an empty list does not.
  readonly usedExports: readonly string[] | null;
};

type ImportAnalysisResult = readonly ImportUsage[] | null;

export interface ImportAnalysis {
  /** null means parsing failed; an empty list means there are no imports. */
  analyze(code: string): ImportAnalysisResult;
  clear(): void;
}

const analysisByBuild = new WeakMap<object, ImportAnalysis>();

/**
 * Share source analysis within one build environment. Callers still resolve
 * requests and apply their own sharing configuration. Clear at buildStart and
 * buildEnd so watch rebuilds start fresh and completed builds release source.
 */
export function getImportAnalysis(build: object): ImportAnalysis {
  let analysis = analysisByBuild.get(build);
  if (!analysis) {
    const importsByCode = new Map<string, ImportAnalysisResult>();
    analysis = {
      analyze(code) {
        const cached = importsByCode.get(code);
        if (cached !== undefined) return cached;
        const imports = analyzeImports(code);
        importsByCode.set(code, imports);
        return imports;
      },
      clear() {
        importsByCode.clear();
      },
    };
    analysisByBuild.set(build, analysis);
  }
  return analysis;
}

type AstNode = Record<string, unknown>;

function isRecord(value: unknown): value is AstNode {
  return value !== null && typeof value === 'object';
}

export function getModuleSource(node: unknown): string | undefined {
  if (!isRecord(node)) return undefined;
  const source = node;
  if (source.type === 'Literal' && typeof source.value === 'string') return source.value;
  if (source.type === 'StringLiteral' && typeof source.value === 'string') return source.value;
  if (source.type !== 'TemplateLiteral') return undefined;

  const expressions = Array.isArray(source.expressions) ? source.expressions : [];
  const quasis = Array.isArray(source.quasis) ? source.quasis : [];
  if (expressions.length > 0 || quasis.length !== 1) return undefined;
  const quasi: unknown = quasis[0];
  if (!isRecord(quasi) || !isRecord(quasi.value)) return undefined;
  const value = quasi.value;
  return typeof value.cooked === 'string'
    ? value.cooked
    : typeof value.raw === 'string'
      ? value.raw
      : undefined;
}

function getExportedName(node: unknown): string | undefined {
  if (!isRecord(node)) return undefined;
  const exported = node;
  if (exported.type === 'Identifier' && typeof exported.name === 'string') return exported.name;
  if (
    (exported.type === 'Literal' || exported.type === 'StringLiteral') &&
    typeof exported.value === 'string'
  ) {
    return exported.value;
  }
  return undefined;
}

function isTypeOnly(node: AstNode) {
  return node.importKind === 'type' || node.exportKind === 'type';
}

export function forEachAstNode(root: unknown, visit: (node: AstNode) => void) {
  const stack: unknown[] = [root];
  const seen = new Set<object>();

  while (stack.length > 0) {
    const value = stack.pop();
    if (!isRecord(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);

    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index--) stack.push(value[index]);
      continue;
    }

    const node = value;
    if (typeof node.type === 'string') visit(node);
    Object.entries(node).forEach(([key, child]) => {
      if (key !== 'parent' && key !== 'loc') stack.push(child);
    });
  }
}

function collectImportDeclaration(
  node: AstNode,
  source: string,
  record: (names: string[], source: string) => void,
  requireAllExports: (source: string) => void
) {
  if (isTypeOnly(node)) return;
  const specifiers: unknown[] = Array.isArray(node.specifiers) ? node.specifiers : [];
  if (specifiers.length === 0) {
    requireAllExports(source);
    return;
  }

  const names: string[] = [];
  for (const specifier of specifiers) {
    if (!isRecord(specifier)) {
      requireAllExports(source);
      return;
    }
    if (isTypeOnly(specifier)) continue;
    if (specifier.type === 'ImportNamespaceSpecifier') {
      requireAllExports(source);
      return;
    }
    if (specifier.type === 'ImportDefaultSpecifier') {
      names.push('default');
      continue;
    }
    if (specifier.type === 'ImportSpecifier') {
      const imported = specifier.imported;
      if (
        isRecord(imported) &&
        (imported.type === 'Literal' || imported.type === 'StringLiteral')
      ) {
        // String-named exports are valid ESM, but generated shared wrappers
        // cannot currently re-export them without special quoting.
        requireAllExports(source);
        return;
      }
      const name = getExportedName(specifier.imported);
      if (!name) {
        requireAllExports(source);
        return;
      }
      names.push(name);
      continue;
    }

    // Future/proposal syntax must not accidentally produce an incomplete bundle.
    requireAllExports(source);
    return;
  }
  record(names, source);
}

function collectReExport(
  node: AstNode,
  source: string,
  record: (names: string[], source: string) => void,
  requireAllExports: (source: string) => void
) {
  if (isTypeOnly(node)) return;
  if (node.type === 'ExportAllDeclaration') {
    requireAllExports(source);
    return;
  }

  const specifiers: unknown[] = Array.isArray(node.specifiers) ? node.specifiers : [];
  if (specifiers.length === 0) {
    // `export {} from 'pkg'` still evaluates pkg for side effects.
    requireAllExports(source);
    return;
  }

  const names: string[] = [];
  for (const specifier of specifiers) {
    if (!isRecord(specifier)) {
      requireAllExports(source);
      return;
    }
    if (isTypeOnly(specifier)) continue;
    if (specifier.type !== 'ExportSpecifier') {
      requireAllExports(source);
      return;
    }
    const local = specifier.local;
    if (isRecord(local) && (local.type === 'Literal' || local.type === 'StringLiteral')) {
      requireAllExports(source);
      return;
    }
    const name = getExportedName(specifier.local);
    if (!name) {
      requireAllExports(source);
      return;
    }
    names.push(name);
  }
  record(names, source);
}

type ModuleRecordName = { kind: string; name: string | null; start: number | null };
type ModuleRecord = {
  staticImports: {
    start: number;
    moduleRequest: { value: string };
    entries: { importName: ModuleRecordName; isType: boolean }[];
  }[];
  staticExports: {
    start: number;
    entries: {
      moduleRequest: { value: string } | null;
      importName: ModuleRecordName;
      isType: boolean;
    }[];
  }[];
  dynamicImports: { start: number; moduleRequest: { start: number; end: number } }[];
};
type ParseSync = (
  filename: string,
  code: string,
  options: { lang: 'js'; preserveParens: boolean }
) => { errors: unknown[]; module: ModuleRecord };

// The module record has no `require()` calls, and it drops `export {} from`.
// A comment after `require` also takes the AST path rather than guess.
const NEEDS_AST_RE =
  /\brequire\s*(?:\?\.\s*)?(?:\(|\/[*/])|\bexport(?:\s|\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/|\/\/[^\n]*\n)*\{(?:\s|\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/|\/\/[^\n]*\n)*\}/;

/**
 * Vite 8 parses with oxc, whose module record lists static imports, re-exports
 * and dynamic imports without materializing the AST. Same result as the AST
 * walk below; `undefined` when this input needs the AST.
 */
function analyzeImportsFromModuleRecord(code: string): ImportAnalysisResult | undefined {
  const parseSync = (vite as { parseSync?: ParseSync }).parseSync;
  if (typeof parseSync !== 'function' || NEEDS_AST_RE.test(code)) return undefined;
  // Same parser options as `vite.parseAst`.
  const result = parseSync('file.js', code, { lang: 'js', preserveParens: false });
  if (result.errors.length > 0) return null;
  const { staticImports, staticExports, dynamicImports } = result.module;

  const found: { start: number; usage: ImportUsage }[] = [];
  const isStringName = (name: ModuleRecordName) =>
    name.start !== null && (code[name.start] === '"' || code[name.start] === "'");
  const add = (start: number, source: string, names: string[] | null) =>
    found.push({ start, usage: { source, usedExports: names } });

  for (const declaration of staticImports) {
    const source = declaration.moduleRequest.value;
    let names: string[] | null = declaration.entries.length === 0 ? null : [];
    for (const { importName } of declaration.entries) {
      if (importName.kind === 'Default') names?.push('default');
      else if (importName.kind === 'Name' && importName.name && !isStringName(importName))
        names?.push(importName.name);
      else names = null;
    }
    add(declaration.start, source, names);
  }
  // Exporting an imported binding (`import { a } from 'x'; export { a }`) is
  // reported with the import statement's span and request; only `export ... from`
  // is a re-export.
  const importStarts = new Set(staticImports.map((declaration) => declaration.start));
  for (const declaration of staticExports) {
    const request = declaration.entries[0]?.moduleRequest;
    if (!request || importStarts.has(declaration.start)) continue;
    const source = request.value;
    let names: string[] | null = [];
    for (const { importName } of declaration.entries) {
      if (importName.kind === 'Name' && importName.name && !isStringName(importName))
        names?.push(importName.name);
      else names = null;
    }
    add(declaration.start, source, names);
  }
  // oxc can report one import() twice, for example inside a destructuring assignment.
  const dynamicStarts = new Set<number>();
  for (const { start, moduleRequest } of dynamicImports) {
    if (dynamicStarts.has(start)) continue;
    dynamicStarts.add(start);
    const text = code.slice(moduleRequest.start, moduleRequest.end);
    const quote = text[0];
    if (
      text.length >= 2 &&
      (quote === '"' || quote === "'" || quote === '`') &&
      text.at(-1) === quote &&
      !text.includes('\\') &&
      !text.slice(1, -1).includes(quote) &&
      !(quote === '`' && text.includes('${'))
    ) {
      add(start, text.slice(1, -1), null);
    } else if (text.includes('\\')) {
      return undefined;
    }
  }
  return found.sort((a, b) => a.start - b.start).map(({ usage }) => usage);
}

function analyzeImports(code: string): ImportAnalysisResult {
  const fromModuleRecord = analyzeImportsFromModuleRecord(code);
  if (fromModuleRecord !== undefined) return fromModuleRecord;

  let ast: ReturnType<typeof vite.parseAst>;
  try {
    ast = vite.parseAst(code);
  } catch {
    return null;
  }

  const imports: ImportUsage[] = [];
  const recordSource = (names: string[], source: string) =>
    imports.push({ source, usedExports: names });
  const requireAllExports = (source: string) => imports.push({ source, usedExports: null });
  const collectImport = (node: AstNode) => {
    if (node.type === 'ImportDeclaration') {
      const source = getModuleSource(node.source);
      if (source) collectImportDeclaration(node, source, recordSource, requireAllExports);
      return;
    }

    if (
      (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') &&
      node.source
    ) {
      const source = getModuleSource(node.source);
      if (source) collectReExport(node, source, recordSource, requireAllExports);
      return;
    }

    if (node.type === 'ImportExpression') {
      const source = getModuleSource(node.source);
      if (source) requireAllExports(source);
      return;
    }

    // CommonJS is not ESM-tree-shakeable. It can still occur in transformed
    // application code, so recognize literal require calls conservatively.
    if (node.type === 'CallExpression') {
      const callee = node.callee;
      const args = Array.isArray(node.arguments) ? node.arguments : [];
      if (
        isRecord(callee) &&
        callee.type === 'Identifier' &&
        callee.name === 'require' &&
        args.length > 0
      ) {
        const source = getModuleSource(args[0]);
        if (source) requireAllExports(source);
      }
    }
  };

  // Vite 8 exposes a visitor for its parser. Older versions keep the same walk.
  if ('Visitor' in vite && typeof vite.Visitor === 'function') {
    const visit = (node: unknown) => {
      if (isRecord(node)) collectImport(node);
    };
    try {
      new vite.Visitor({
        ImportDeclaration: visit,
        ExportNamedDeclaration: visit,
        ExportAllDeclaration: visit,
        ImportExpression: visit,
        CallExpression: visit,
      }).visit(ast);
      return imports;
    } catch {
      // The recursive visitor can overflow on deeply nested expressions.
      // Discard partial results before retrying with the iterative walker.
      imports.length = 0;
    }
  }

  forEachAstNode(ast, collectImport);
  return imports;
}

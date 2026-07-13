import { parseAst } from 'vite';
import type { NormalizedShared, ShareItem } from './normalizeModuleFederationOptions';
import { normalizePathForImport } from './buildPaths';

type SharedSourceMatcher = (source: string, shared: NormalizedShared) => string | undefined;

type TreeShakingExportRecord = {
  requiresFullBundle: boolean;
  usedExports: Set<string>;
};

/**
 * `unknown` means that analysis has not observed this concrete request yet.
 * `full` is deliberately distinct from an empty export list: the module was
 * consumed as a namespace, for side effects, or through another form that
 * cannot safely be represented by a subset of its exports.
 */
export type TreeShakingExportUsage =
  | { kind: 'unknown' }
  | { kind: 'full' }
  | { kind: 'exports'; usedExports: string[] };

type RecordTreeShakingExports = (sharedKey: string, exports: string[], request?: string) => void;
type MarkTreeShakingPackageUnsafe = (sharedKey: string, request?: string) => void;

/**
 * Analysis is scoped by both the configured share key and the concrete module
 * request. A prefix share such as `lodash/` may materialize separate wrappers
 * for `lodash/get` and `lodash/debounce`; combining those export sets would
 * generate invalid wrappers and defeat per-subpath tree shaking.
 */
const inferredTreeShakingUsage = new Map<string, Map<string, TreeShakingExportRecord>>();
let treeShakingBuildMode = false;

export function setTreeShakingBuildMode(enabled: boolean) {
  treeShakingBuildMode = enabled;
}

export function resetTreeShakingExports() {
  inferredTreeShakingUsage.clear();
}

function getOrCreateExportRecord(sharedKey: string, request: string): TreeShakingExportRecord {
  let byRequest = inferredTreeShakingUsage.get(sharedKey);
  if (!byRequest) {
    byRequest = new Map();
    inferredTreeShakingUsage.set(sharedKey, byRequest);
  }

  let record = byRequest.get(request);
  if (!record) {
    record = { requiresFullBundle: false, usedExports: new Set<string>() };
    byRequest.set(request, record);
  }
  return record;
}

export function recordTreeShakingExports(
  sharedKey: string,
  exports: string[],
  request = sharedKey
) {
  const record = getOrCreateExportRecord(sharedKey, request);
  exports.forEach((name) => record.usedExports.add(name));
}

export function markTreeShakingPackageUnsafe(sharedKey: string, request = sharedKey) {
  getOrCreateExportRecord(sharedKey, request).requiresFullBundle = true;
}

function getExportRecords(sharedKey: string | undefined, request: string) {
  if (sharedKey) {
    const records = inferredTreeShakingUsage.get(sharedKey);
    const wildcard = records?.get('*');
    const exact = records?.get(request);
    return [wildcard, exact === wildcard ? undefined : exact].filter(
      (record): record is TreeShakingExportRecord => !!record
    );
  }

  const records: TreeShakingExportRecord[] = [];
  inferredTreeShakingUsage.forEach((byRequest, configuredKey) => {
    const wildcard = byRequest.get('*');
    const exact = byRequest.get(request);
    const keyBase = configuredKey.endsWith('/') ? configuredKey.slice(0, -1) : configuredKey;
    const requestMatchesConfiguredKey = request === keyBase || request.startsWith(`${keyBase}/`);
    if (wildcard && requestMatchesConfiguredKey) records.push(wildcard);
    if (exact && exact !== wildcard) records.push(exact);
  });
  return records;
}

/**
 * Return the analyzed requirement for one concrete shared request.
 *
 * Callers that know the configured share key should pass it explicitly. The
 * fallback lookup across keys keeps aliases/backwards-compatible callers
 * working, while still keeping each concrete request's exports isolated.
 */
export function getTreeShakingExportUsage(
  request: string,
  shareItem?: ShareItem,
  sharedKey?: string
): TreeShakingExportUsage | undefined {
  const treeShaking = shareItem?.shareConfig.treeShaking;
  if (!treeShaking || !treeShakingBuildMode) return undefined;

  const records = getExportRecords(sharedKey, request);
  if (records.some((record) => record.requiresFullBundle)) return { kind: 'full' };

  const configured = treeShaking.usedExports ?? [];
  const result = new Set(configured);
  records.forEach((record) => record.usedExports.forEach((name) => result.add(name)));

  if (result.size > 0) {
    return { kind: 'exports', usedExports: [...result].sort() };
  }
  return records.length > 0 ? { kind: 'exports', usedExports: [] } : { kind: 'unknown' };
}

/**
 * @deprecated Migrate callers to `getTreeShakingExportUsage`. This accessor
 * cannot represent the important distinction between `full` and `unknown`.
 */
export function getTreeShakingUsedExports(
  request: string,
  shareItem?: ShareItem,
  sharedKey?: string
): string[] | undefined {
  const usage = getTreeShakingExportUsage(request, shareItem, sharedKey);
  return usage?.kind === 'exports' && usage.usedExports.length > 0 ? usage.usedExports : undefined;
}

type AstNode = {
  type?: string;
  [key: string]: unknown;
};

function getModuleSource(node: unknown): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const source = node as AstNode;
  if (source.type === 'Literal' && typeof source.value === 'string') return source.value;
  if (source.type === 'StringLiteral' && typeof source.value === 'string') return source.value;
  if (source.type !== 'TemplateLiteral') return undefined;

  const expressions = Array.isArray(source.expressions) ? source.expressions : [];
  const quasis = Array.isArray(source.quasis) ? source.quasis : [];
  if (expressions.length > 0 || quasis.length !== 1) return undefined;
  const quasi = quasis[0] as AstNode | undefined;
  const value = quasi?.value as { cooked?: unknown; raw?: unknown } | undefined;
  return typeof value?.cooked === 'string'
    ? value.cooked
    : typeof value?.raw === 'string'
      ? value.raw
      : undefined;
}

function getExportedName(node: unknown): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const exported = node as AstNode;
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

function forEachAstNode(root: AstNode, visit: (node: AstNode) => void) {
  const stack: unknown[] = [root];
  const seen = new Set<object>();

  while (stack.length > 0) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    if (seen.has(value)) continue;
    seen.add(value);

    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index--) stack.push(value[index]);
      continue;
    }

    const node = value as AstNode;
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
  markUnsafe: (source: string) => void
) {
  if (isTypeOnly(node)) return;
  const specifiers = Array.isArray(node.specifiers) ? (node.specifiers as AstNode[]) : [];
  if (specifiers.length === 0) {
    markUnsafe(source);
    return;
  }

  const names: string[] = [];
  for (const specifier of specifiers) {
    if (isTypeOnly(specifier)) continue;
    if (specifier.type === 'ImportNamespaceSpecifier') {
      markUnsafe(source);
      return;
    }
    if (specifier.type === 'ImportDefaultSpecifier') {
      names.push('default');
      continue;
    }
    if (specifier.type === 'ImportSpecifier') {
      const imported = specifier.imported as AstNode | undefined;
      if (imported?.type === 'Literal' || imported?.type === 'StringLiteral') {
        // String-named exports are valid ESM, but generated shared wrappers
        // cannot currently re-export them without special quoting.
        markUnsafe(source);
        return;
      }
      const name = getExportedName(specifier.imported);
      if (!name) {
        markUnsafe(source);
        return;
      }
      names.push(name);
      continue;
    }

    // Future/proposal syntax must not accidentally produce an incomplete bundle.
    markUnsafe(source);
    return;
  }
  record(names, source);
}

function collectReExport(
  node: AstNode,
  source: string,
  record: (names: string[], source: string) => void,
  markUnsafe: (source: string) => void
) {
  if (isTypeOnly(node)) return;
  if (node.type === 'ExportAllDeclaration') {
    markUnsafe(source);
    return;
  }

  const specifiers = Array.isArray(node.specifiers) ? (node.specifiers as AstNode[]) : [];
  if (specifiers.length === 0) {
    // `export {} from 'pkg'` still evaluates pkg for side effects.
    markUnsafe(source);
    return;
  }

  const names: string[] = [];
  for (const specifier of specifiers) {
    if (isTypeOnly(specifier)) continue;
    if (specifier.type !== 'ExportSpecifier') {
      markUnsafe(source);
      return;
    }
    const local = specifier.local as AstNode | undefined;
    if (local?.type === 'Literal' || local?.type === 'StringLiteral') {
      markUnsafe(source);
      return;
    }
    const name = getExportedName(specifier.local);
    if (!name) {
      markUnsafe(source);
      return;
    }
    names.push(name);
  }
  record(names, source);
}

/**
 * Collect the exports required by a consumer's ESM graph.
 *
 * Parsing the module avoids treating import-looking text in comments, strings,
 * templates, or regular expressions as real dependencies. If parsing fails,
 * every configured tree-shaken share is conservatively marked as requiring its
 * full bundle instead of guessing from source text.
 *
 * Generated federation wrappers are excluded because their imports describe
 * the wrapper implementation, not the consumer's requirements.
 */
export function collectTreeShakingImports(
  code: string,
  id: string,
  shared: NormalizedShared,
  findSharedKey: SharedSourceMatcher,
  record: RecordTreeShakingExports,
  markUnsafe: MarkTreeShakingPackageUnsafe
) {
  const normalizedId = normalizePathForImport(id);
  if (
    normalizedId.includes('__prebuild__') ||
    normalizedId.includes('__loadShare__') ||
    normalizedId.includes('__mf_tree_shaking_graph__')
  ) {
    return;
  }

  let ast: AstNode;
  try {
    ast = parseAst(code) as unknown as AstNode;
  } catch {
    Object.entries(shared).forEach(([sharedKey, shareItem]) => {
      if (shareItem.shareConfig.treeShaking) markUnsafe(sharedKey, '*');
    });
    return;
  }

  const matchShared = (source: string) => {
    const sharedKey = findSharedKey(source, shared);
    return sharedKey && shared[sharedKey]?.shareConfig.treeShaking ? sharedKey : undefined;
  };
  const recordSource = (names: string[], source: string) => {
    const sharedKey = matchShared(source);
    if (sharedKey) record(sharedKey, names, source);
  };
  const markSourceUnsafe = (source: string) => {
    const sharedKey = matchShared(source);
    if (sharedKey) markUnsafe(sharedKey, source);
  };

  forEachAstNode(ast, (node) => {
    if (node.type === 'ImportDeclaration') {
      const source = getModuleSource(node.source);
      if (source) collectImportDeclaration(node, source, recordSource, markSourceUnsafe);
      return;
    }

    if (
      (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') &&
      node.source
    ) {
      const source = getModuleSource(node.source);
      if (source) collectReExport(node, source, recordSource, markSourceUnsafe);
      return;
    }

    if (node.type === 'ImportExpression') {
      const source = getModuleSource(node.source);
      if (source) markSourceUnsafe(source);
      return;
    }

    // CommonJS is not ESM-tree-shakeable. It can still occur in transformed
    // application code, so recognize literal require calls conservatively.
    if (node.type === 'CallExpression') {
      const callee = node.callee as AstNode | undefined;
      const args = Array.isArray(node.arguments) ? node.arguments : [];
      if (callee?.type === 'Identifier' && callee.name === 'require' && args.length > 0) {
        const source = getModuleSource(args[0]);
        if (source) markSourceUnsafe(source);
      }
    }
  });
}

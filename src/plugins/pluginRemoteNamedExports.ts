/**
 * Transforms consumer-side imports of remote modules so that named exports
 * are accessible even when the bundler does not support syntheticNamedExports
 * (Rolldown / Vite 8+).
 *
 * The remote proxy module exports:
 *   export const __moduleExports = exportModule;   // full namespace
 *   export default exportModule.default ?? exportModule;  // unwrapped default
 *
 * This plugin rewrites consumer code:
 *   import { foo } from "remote/xxx"
 *     → import { __moduleExports as __mf_ns_0 } from "remote/xxx"; const { foo } = __mf_ns_0;
 *
 *   import("remote/xxx")
 *     → import("remote/xxx").then(…)  // spreads __moduleExports into namespace
 *
 * NOTE: `export * from "remote/xxx"` is not supported — Rolldown cannot
 * statically resolve the set of exported names from a federated remote at
 * build time.  Use explicit named re-exports instead.
 */
import type { Plugin } from 'vite';
import { CodeRewriter, type SourceMapLike } from '../utils/codeRewriter';
import type { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { LOAD_REMOTE_TAG, LOAD_SHARE_TAG } from '../virtualModules';

const JS_EXTENSIONS_RE = /\.(?:[mc]?[jt]sx?|vue|svelte)(?:\?|$)/;

// ── Normalized import descriptors ─────────────────────────────────

interface StaticImportInfo {
  kind: 'static';
  source: string;
  start: number;
  end: number;
  named: Array<{ imported: string; local: string }>;
  defaultLocal?: string;
  namespaceLocal?: string;
}

interface ReexportInfo {
  kind: 'reexport';
  source: string;
  start: number;
  end: number;
  specifiers: Array<{ local: string; exported: string }>;
}

interface ExportAllInfo {
  kind: 'export-all';
  source: string;
  start: number;
  end: number;
}

interface DynamicImportInfo {
  kind: 'dynamic';
  start: number;
  end: number;
  originalText: string;
}

type ImportInfo = StaticImportInfo | ReexportInfo | ExportAllInfo | DynamicImportInfo;
type NamedSpecifierKind = 'import' | 'export';
type ParsedNamedSpecifier<T extends NamedSpecifierKind> = T extends 'import'
  ? { imported: string; local: string }
  : { local: string; exported: string };

interface WalkContext {
  skip(): void;
}

interface WalkVisitor {
  enter(this: WalkContext, node: any): void;
}

function isAstNode(value: unknown): value is { type: string; [key: string]: unknown } {
  return !!value && typeof value === 'object' && typeof (value as any).type === 'string';
}

function walkAST(root: unknown, visitor: WalkVisitor): void {
  const seen = new WeakSet<object>();

  function visit(node: unknown): void {
    if (!isAstNode(node)) return;
    if (seen.has(node)) return;
    seen.add(node);

    let skipped = false;
    const context: WalkContext = {
      skip() {
        skipped = true;
      },
    };

    visitor.enter.call(context, node);
    if (skipped) return;

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
      } else {
        visit(value);
      }
    }
  }

  visit(root);
}

// ── Shared rewrite logic ──────────────────────────────────────────

function parseNamedSpecifiers<T extends NamedSpecifierKind>(
  specifiersRaw: string,
  kind: T
): Array<ParsedNamedSpecifier<T>> {
  return specifiersRaw
    .split(',')
    .map((s: string) => s.trim())
    .filter((s: string) => s.length > 0 && !s.startsWith('type '))
    .map((s: string) => {
      const asMatch = s.match(/^(\w+)\s+as\s+(\w+)$/);
      const sourceName = asMatch ? asMatch[1] : s;
      const targetName = asMatch ? asMatch[2] : s;
      return (
        kind === 'import'
          ? { imported: sourceName, local: targetName }
          : { local: sourceName, exported: targetName }
      ) as ParsedNamedSpecifier<T>;
    });
}

function wrapDynamicImport(original: string): string {
  return (
    `${original}.then(function(__mf_m__) {\n` +
    `  var __mf_pending__ = __mf_m__ && __mf_m__.__mf_remote_pending;\n` +
    `  var __mf_ready__ = __mf_pending__ && typeof __mf_pending__.then === "function"\n` +
    `    ? __mf_pending__.then(function(__mf_resolved__) { return __mf_resolved__ || __mf_m__; })\n` +
    `    : Promise.resolve(__mf_m__);\n` +
    `  return __mf_ready__.then(function(__mf_m__) {\n` +
    `  if (!__mf_m__ || !__mf_m__.__moduleExports) {\n` +
    `    if (__mf_m__ && __mf_m__.default && typeof __mf_m__.default === "object" && __mf_m__.default.__esModule) {\n` +
    `      var __mf_nested_e__ = __mf_m__.default;\n` +
    `      var __mf_nested_ns__ = Object.create(null);\n` +
    `      Object.defineProperty(__mf_nested_ns__, Symbol.toStringTag, { value: "Module" });\n` +
    `      Object.keys(__mf_nested_e__).forEach(function(k) { if (k !== "__esModule") __mf_nested_ns__[k] = __mf_nested_e__[k] });\n` +
    `      if ("default" in __mf_nested_e__) __mf_nested_ns__.default = __mf_nested_e__.default;\n` +
    `      return __mf_nested_ns__;\n` +
    `    }\n` +
    `    var __mf_flat_ns__ = Object.create(null);\n` +
    `    Object.defineProperty(__mf_flat_ns__, Symbol.toStringTag, { value: "Module" });\n` +
    `    var __mf_src__ = __mf_m__;\n` +
    `    if (__mf_src__ && __mf_src__.default && typeof __mf_src__.default === "object" && __mf_src__.default.__esModule) __mf_src__ = __mf_src__.default;\n` +
    `    if (__mf_src__) {\n` +
    `      Object.keys(__mf_src__).forEach(function(k) { if (k !== "__esModule") __mf_flat_ns__[k] = __mf_src__[k]; });\n` +
    `      __mf_flat_ns__.default = "default" in __mf_src__ ? __mf_src__.default : __mf_src__;\n` +
    `    }\n` +
    `    return __mf_flat_ns__;\n` +
    `  }\n` +
    `  var __mf_ns__ = Object.create(null);\n` +
    `  Object.defineProperty(__mf_ns__, Symbol.toStringTag, { value: "Module" });\n` +
    `  var __mf_e__ = __mf_m__.__moduleExports;\n` +
    `  if (__mf_e__ && __mf_e__.default && typeof __mf_e__.default === "object" && __mf_e__.default.__esModule) __mf_e__ = __mf_e__.default;\n` +
    `  Object.keys(__mf_e__).forEach(function(k) { if (k !== "__esModule") __mf_ns__[k] = __mf_e__[k] });\n` +
    `  if ("default" in __mf_e__) __mf_ns__.default = __mf_e__.default;\n` +
    `  else if ("default" in __mf_m__) __mf_ns__.default = __mf_m__.default;\n` +
    `  return __mf_ns__;\n` +
    `  });\n` +
    `})`
  );
}

function applyRewrites(
  code: string,
  imports: ImportInfo[],
  id: string
): { code: string; map: SourceMapLike } | undefined {
  if (imports.length === 0) return;

  const ms = new CodeRewriter(code);
  let changed = false;
  // Per-file counter — deterministic regardless of file processing order.
  let counter = 0;
  let namedProxyHelperDeclared = false;
  const dependencyPendingIds: string[] = [];
  const namedProxyHelper = `function __mfCreateNamedRemoteProxy(ns, key) {
  const target = function (...args) {
    const value = ns[key];
    return typeof value === "function" ? value.apply(this, args) : value;
  };
  return new Proxy(target, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      const value = ns[key];
      if (prop === Symbol.toPrimitive) return () => value;
      const item = value == null ? undefined : value[prop];
      return typeof item === "function" ? item.bind(value) : item;
    },
    apply(target, thisArg, args) {
      return target.apply(thisArg, args);
    }
  });
}`;

  for (const imp of imports) {
    switch (imp.kind) {
      case 'static': {
        const src = JSON.stringify(imp.source);

        if (imp.namespaceLocal && !imp.defaultLocal && imp.named.length === 0) {
          const pendingId = `${imp.namespaceLocal}__mf_pending`;
          dependencyPendingIds.push(pendingId);
          // import * as ns from "remote/xxx"
          ms.overwrite(
            imp.start,
            imp.end,
            `import { __moduleExports as ${imp.namespaceLocal}, __mf_remote_pending as ${pendingId} } from ${src};`
          );
        } else {
          const nsId = `__mf_ns_${counter++}`;
          const pendingId = `${nsId}_pending`;
          dependencyPendingIds.push(pendingId);
          const importParts: string[] = [];

          if (imp.defaultLocal) importParts.push(`default as ${imp.defaultLocal}`);
          importParts.push(`__moduleExports as ${nsId}`);
          importParts.push(`__mf_remote_pending as ${pendingId}`);

          let rewrite = `import { ${importParts.join(', ')} } from ${src};`;
          if (imp.named.length > 0) {
            const isProxyId = `__mf_is_proxy_${counter++}`;
            const tempNames = imp.named.map((_s) => `__mf_named_${counter++}`);
            const destructParts = imp.named.map((s, index) => `${s.imported}: ${tempNames[index]}`);
            const bindingLines = imp.named.map((s, index) => {
              const temp = tempNames[index];
              return `const ${s.local} = ${isProxyId} ? __mfCreateNamedRemoteProxy(${nsId}, ${JSON.stringify(s.imported)}) : ${temp};`;
            });
            if (!namedProxyHelperDeclared) {
              rewrite += `\n${namedProxyHelper}`;
              namedProxyHelperDeclared = true;
            }
            rewrite += `\nconst ${isProxyId} = ${nsId} && ${nsId}.__mf_is_remote_proxy;`;
            rewrite += `\nconst { ${destructParts.join(', ')} } = ${isProxyId} ? {} : ${nsId};`;
            rewrite += `\n${bindingLines.join('\n')}`;
          }

          ms.overwrite(imp.start, imp.end, rewrite);
        }
        changed = true;
        break;
      }

      case 'reexport': {
        const src = JSON.stringify(imp.source);
        const nsId = `__mf_ns_${counter++}`;
        const pendingId = `${nsId}_pending`;
        dependencyPendingIds.push(pendingId);

        const vars = imp.specifiers.map((s) => {
          const tmp = `__mf_re_${counter++}`;
          return { ...s, tmp };
        });

        const importLine = `import { __moduleExports as ${nsId}, __mf_remote_pending as ${pendingId} } from ${src};`;
        const varLines = vars
          .map((v) => `let ${v.tmp} = ${nsId}[${JSON.stringify(v.local)}];`)
          .join('\n');
        const assignLines = vars
          .map((v) => `${v.tmp} = ${nsId}[${JSON.stringify(v.local)}];`)
          .join('\n');
        const syncLine = `${pendingId}.then(() => {\n${assignLines}\n});`;
        const exportLine = `export { ${vars.map((v) => `${v.tmp} as ${v.exported}`).join(', ')} };`;

        ms.overwrite(imp.start, imp.end, `${importLine}\n${varLines}\n${syncLine}\n${exportLine}`);
        changed = true;
        break;
      }

      case 'export-all': {
        console.warn(
          `[module-federation] "export * from '${imp.source}'" is not supported ` +
            `with Rolldown — use explicit named re-exports instead. (${id})`
        );
        break;
      }

      case 'dynamic': {
        ms.overwrite(imp.start, imp.end, wrapDynamicImport(imp.originalText));
        changed = true;
        break;
      }
    }
  }

  if (!changed) return;
  if (dependencyPendingIds.length > 0) {
    ms.overwrite(
      code.length,
      code.length,
      `\nexport const __mf_remote_dependency_pending = Promise.all([${dependencyPendingIds.join(', ')}]);`
    );
  }
  return {
    code: ms.toString(),
    map: ms.generateMap(id),
  };
}

// ── AST-based collection ──────────────────────────────────────────

async function collectFromAST(
  ast: any,
  code: string,
  isRemoteImport: (source: string) => boolean
): Promise<ImportInfo[]> {
  const result: ImportInfo[] = [];

  walkAST(ast, {
    enter(node: any) {
      // ── static imports ──────────────────────────────────────
      if (node.type === 'ImportDeclaration' && node.source?.value) {
        if (!isRemoteImport(node.source.value)) return;

        const specifiers = node.specifiers || [];
        // Filter out inline type-only specifiers (e.g. `import { type Foo, bar }`)
        // to guard against parsers that support TypeScript syntax.
        const named = specifiers
          .filter((s: any) => s.type === 'ImportSpecifier' && s.importKind !== 'type')
          .map((s: any) => ({
            imported: s.imported.name ?? s.imported.value,
            local: s.local.name,
          }));
        const defaultSpec = specifiers.find((s: any) => s.type === 'ImportDefaultSpecifier');
        const nsSpec = specifiers.find((s: any) => s.type === 'ImportNamespaceSpecifier');

        // default-only → already works, skip
        if (named.length === 0 && !nsSpec) return;

        result.push({
          kind: 'static',
          source: node.source.value,
          start: node.start,
          end: node.end,
          named,
          defaultLocal: defaultSpec?.local.name,
          namespaceLocal: nsSpec?.local.name,
        });
      }

      // ── re-exports: export { foo } from "remote/xxx" ──────
      if (
        node.type === 'ExportNamedDeclaration' &&
        node.source?.value &&
        isRemoteImport(node.source.value)
      ) {
        const specifiers = (node.specifiers || [])
          .filter((s: any) => s.exportKind !== 'type')
          .map((s: any) => ({
            local: s.local.name ?? s.local.value,
            exported: s.exported.name ?? s.exported.value,
          }));

        if (specifiers.length === 0) return;

        result.push({
          kind: 'reexport',
          source: node.source.value,
          start: node.start,
          end: node.end,
          specifiers,
        });
      }

      // ── export * from "remote/xxx" (unsupported) ──────────
      if (
        node.type === 'ExportAllDeclaration' &&
        node.source?.value &&
        isRemoteImport(node.source.value)
      ) {
        this.skip();
        result.push({
          kind: 'export-all',
          source: node.source.value,
          start: node.start,
          end: node.end,
        });
      }

      // ── dynamic imports: import("remote/xxx") ─────────────
      if (node.type === 'ImportExpression') {
        const source = node.source;

        if (
          source.type !== 'Literal' &&
          source.type !== 'StringLiteral' &&
          source.type !== 'TemplateLiteral'
        )
          return;

        const value =
          source.type === 'TemplateLiteral'
            ? source.quasis?.length === 1
              ? source.quasis[0].value?.cooked
              : undefined
            : source.value;

        if (!value || !isRemoteImport(value)) return;

        result.push({
          kind: 'dynamic',
          start: node.start,
          end: node.end,
          originalText: code.slice(node.start, node.end),
        });
      }
    },
  });

  return result;
}

// ── Regex fallback collection ─────────────────────────────────────
//
// NOTE: Specifier parsing uses regex (e.g. /\{([^}]*)\}/ and .split(','))
// which does not handle exotic specifiers like string literals
// (`export { foo as "bar-baz" }`).  This is acceptable because federated
// remote module names are always valid JS identifiers.

function collectFromRegex(
  code: string,
  isRemoteImport: (source: string) => boolean
): ImportInfo[] | undefined {
  const result: ImportInfo[] = [];
  const codePositions = createCodePositionMap(code);

  const importAttributes = String.raw`(?:\s+(?:with|assert)\s+\{[^;]*\})?`;
  const staticRe = new RegExp(
    String.raw`^\s*import\s+([\s\S]*?)\s+from\s+(['"])([^'"]+)\2${importAttributes}\s*;?`,
    'gm'
  );
  for (const match of code.matchAll(staticRe)) {
    const [full, specifiersPartRaw, , source] = match;
    if (!codePositions[match.index!]) continue;
    if (!isRemoteImport(source)) continue;

    const specifiersPart = specifiersPartRaw.trim();
    if (/^type\s/.test(specifiersPart)) continue;

    const nsMatch = specifiersPart.match(/^\*\s+as\s+(\w+)$/);
    if (nsMatch) {
      result.push({
        kind: 'static',
        source,
        start: match.index!,
        end: match.index! + full.length,
        named: [],
        namespaceLocal: nsMatch[1],
      });
      continue;
    }

    const braceMatch = specifiersPart.match(/\{([^}]*)\}/);
    if (!braceMatch) continue;

    const named = parseNamedSpecifiers(braceMatch[1], 'import');
    if (named.length === 0) continue;

    const defaultMatch = specifiersPart.match(/^(\w+)\s*,/);

    result.push({
      kind: 'static',
      source,
      start: match.index!,
      end: match.index! + full.length,
      named,
      defaultLocal: defaultMatch?.[1],
    });
  }

  const reexportRe = new RegExp(
    String.raw`^\s*export\s+\{([\s\S]*?)\}\s+from\s+(['"])([^'"]+)\2${importAttributes}\s*;?`,
    'gm'
  );
  for (const match of code.matchAll(reexportRe)) {
    const [full, specifiersRaw, , source] = match;
    if (!codePositions[match.index!]) continue;
    if (!isRemoteImport(source)) continue;

    const specifiers = parseNamedSpecifiers(specifiersRaw, 'export');
    if (specifiers.length === 0) continue;

    result.push({
      kind: 'reexport',
      source,
      start: match.index!,
      end: match.index! + full.length,
      specifiers,
    });
  }

  const exportAllRe = new RegExp(
    String.raw`^\s*export\s+\*\s+from\s+(['"])([^'"]+)\1${importAttributes}\s*;?`,
    'gm'
  );
  for (const match of code.matchAll(exportAllRe)) {
    const [full, , source] = match;
    if (!codePositions[match.index!]) continue;
    if (!isRemoteImport(source)) continue;

    result.push({
      kind: 'export-all',
      source,
      start: match.index!,
      end: match.index! + full.length,
    });
  }

  const dynamicRe = /import\(\s*(?:\/\*[\s\S]*?\*\/\s*)?(['"])([^'"]+)\1\s*\)/g;
  for (const match of code.matchAll(dynamicRe)) {
    const [full, , source] = match;
    if (!codePositions[match.index!]) continue;
    if (!isRemoteImport(source)) continue;

    result.push({
      kind: 'dynamic',
      start: match.index!,
      end: match.index! + full.length,
      originalText: full,
    });
  }

  return result.length > 0 ? result : undefined;
}

function createCodePositionMap(code: string): boolean[] {
  const positions = Array(code.length).fill(true);

  function mask(start: number, end: number): void {
    for (let i = start; i < end; i++) positions[i] = false;
  }

  for (let i = 0; i < code.length; ) {
    const char = code[i];
    const next = code[i + 1];

    if (char === '/' && next === '/') {
      const start = i;
      i += 2;
      while (i < code.length && code[i] !== '\n' && code[i] !== '\r') i++;
      mask(start, i);
      continue;
    }

    if (char === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i = Math.min(code.length, i + 2);
      mask(start, i);
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      const start = i++;
      while (i < code.length) {
        if (code[i] === '\\') {
          i += 2;
          continue;
        }
        if (code[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      mask(start, i);
      continue;
    }

    i++;
  }

  return positions;
}

// ── Plugin factory ────────────────────────────────────────────────

export function pluginRemoteNamedExports(options: NormalizedModuleFederationOptions): Plugin {
  const remoteNames = Object.keys(options.remotes);
  const isNodeModulesId = (id: string) =>
    id.includes('/node_modules/') || id.includes('\\node_modules\\');

  function isRemoteImport(source: string, importerId: string): boolean {
    return (
      remoteNames.some((name) => {
        if (source.startsWith(name + '/')) return true;
        if (source !== name) return false;
        return !isNodeModulesId(importerId);
      }) || source.includes(LOAD_REMOTE_TAG)
    );
  }

  return {
    name: 'module-federation-remote-named-exports',
    enforce: 'post',
    async transform(code: string, id: string) {
      if (remoteNames.length === 0) return;
      // Skip federation internal modules
      if (id.includes(LOAD_REMOTE_TAG) || id.includes(LOAD_SHARE_TAG)) return;
      // Only process JS-like files to avoid parsing CSS/JSON/etc.
      if (!JS_EXTENSIONS_RE.test(id)) return;
      // Quick bail-out: does the source mention any remote name?
      if (!remoteNames.some((name) => code.includes(name))) return;
      const matchesRemoteImport = (source: string) => isRemoteImport(source, id);

      let imports: ImportInfo[] | undefined;

      try {
        const ast = this.parse(code);
        imports = await collectFromAST(ast, code, matchesRemoteImport);
      } catch {
        if ((id.includes('.vue') || id.includes('.svelte')) && /^\s*</.test(code)) return;
        // this.parse() delegates to acorn which does not support TypeScript
        // syntax (import type, interfaces, generics, etc.). Fall back to a
        // targeted scanner so TS/TSX consumer files are still transformed.
        imports = collectFromRegex(code, matchesRemoteImport);
      }

      if (!imports) return;
      return applyRewrites(code, imports, id);
    },
  };
}

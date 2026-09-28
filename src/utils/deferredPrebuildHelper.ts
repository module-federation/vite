import path from 'node:path';
import { parseAst } from 'vite';

type Chunk = {
  type: 'chunk';
  fileName: string;
  code: string;
  imports?: string[];
  modules?: Record<string, unknown>;
};
type Bundle = Record<string, Chunk | { type: 'asset'; fileName: string }>;

function dynamicImportSources(node: unknown, sources = new Set<string>()): Set<string> {
  if (!node || typeof node !== 'object') return sources;
  if (Array.isArray(node)) {
    for (const child of node) dynamicImportSources(child, sources);
    return sources;
  }
  const record = node as Record<string, unknown>;
  if (record.type === 'ImportExpression') {
    const imported = record.source as Record<string, unknown> | undefined;
    if (typeof imported?.value === 'string') sources.add(imported.value);
    if (imported?.type === 'TemplateLiteral' && Array.isArray(imported.quasis)) {
      const expressions = imported.expressions as unknown[] | undefined;
      const quasi = imported.quasis[0] as Record<string, unknown> | undefined;
      const value = quasi?.value as Record<string, unknown> | undefined;
      if (expressions?.length === 0 && typeof value?.cooked === 'string') {
        sources.add(value.cooked);
      }
    }
  }
  for (const child of Object.values(record)) dynamicImportSources(child, sources);
  return sources;
}

function isExportAllHelper(code: string, exportName: string): boolean {
  try {
    const ast = parseAst(code);
    let localName: string | undefined;
    for (const node of ast.body) {
      if (node.type !== 'ExportNamedDeclaration') continue;
      for (const specifier of node.specifiers) {
        if (
          specifier.type === 'ExportSpecifier' &&
          specifier.exported.type === 'Identifier' &&
          specifier.exported.name === exportName &&
          specifier.local.type === 'Identifier'
        ) {
          localName = specifier.local.name;
        }
      }
    }
    if (!localName) return false;
    for (const node of ast.body) {
      if (node.type !== 'VariableDeclaration') continue;
      for (const declaration of node.declarations) {
        if (declaration.id.type !== 'Identifier' || declaration.id.name !== localName) continue;
        const initializer = declaration.init;
        if (!initializer) return false;
        const source = code.slice(initializer.start, initializer.end);
        return source.includes('Symbol.toStringTag') && source.includes('Module');
      }
    }
  } catch {
    // Keep the emitted import if an unfamiliar bundler format cannot be inspected.
  }
  return false;
}

/**
 * Rolldown sometimes places its shared namespace helper in a local prebuild
 * chunk. A loadShare wrapper then imports that helper statically, evaluating the
 * fallback even when a host provider is already in the cache. Inline only the
 * recognized Rolldown helper; leave every other prebuild import untouched.
 */
export function inlineDeferredPrebuildNamespaceHelper(bundle: Bundle): void {
  for (const chunk of Object.values(bundle)) {
    if (chunk.type !== 'chunk' || !chunk.fileName.includes('__loadShare__')) continue;
    let ast: ReturnType<typeof parseAst>;
    try {
      ast = parseAst(chunk.code);
    } catch {
      continue;
    }
    const edits: { start: number; end: number; replacement: string }[] = [];
    const deferredSources = dynamicImportSources(ast);
    const retainedImports = new Set<string>();
    const removedImports = new Set<string>();
    for (const node of ast.body) {
      if (node.type !== 'ImportDeclaration' || typeof node.source.value !== 'string') continue;
      const source = node.source.value;
      const targetName = path.posix.normalize(
        path.posix.join(path.posix.dirname(chunk.fileName), source)
      );
      const [specifier] = node.specifiers;
      const exported = specifier?.type === 'ImportSpecifier' && specifier.imported;
      const target = bundle[targetName];
      if (
        !source.includes('__prebuild__') ||
        node.specifiers.length !== 1 ||
        !exported ||
        exported.type !== 'Identifier' ||
        target?.type !== 'chunk' ||
        !deferredSources.has(source) ||
        !Object.keys(target.modules ?? {}).some((id) => id.includes('rolldown/runtime.js')) ||
        !isExportAllHelper(target.code, exported.name)
      ) {
        retainedImports.add(targetName);
        continue;
      }
      removedImports.add(targetName);
      edits.push({
        start: node.start,
        end: node.end,
        replacement: `const ${specifier.local.name} = (all, noSymbols) => {
          const namespace = {};
          for (const name in all) Object.defineProperty(namespace, name, {
            get: all[name], enumerable: true,
          });
          if (!noSymbols) Object.defineProperty(namespace, Symbol.toStringTag, { value: 'Module' });
          return namespace;
        };`,
      });
    }
    if (edits.length === 0) continue;
    for (const edit of edits.reverse()) {
      chunk.code = chunk.code.slice(0, edit.start) + edit.replacement + chunk.code.slice(edit.end);
    }
    if (chunk.imports) {
      chunk.imports = chunk.imports.filter(
        (imported) => !removedImports.has(imported) || retainedImports.has(imported)
      );
    }
  }
}

import path from 'node:path';
import { parseAst } from 'vite';
import { LOAD_SHARE_TAG, PREBUILD_TAG } from '../virtualModules/shareTags';
import { forEachAstNode, getModuleSource } from './importAnalysis';

type Chunk = {
  type: 'chunk';
  fileName: string;
  code: string;
  imports?: string[];
  modules?: Record<string, unknown>;
};
type Bundle = Record<string, Chunk | { type: 'asset'; fileName: string }>;

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
    if (chunk.type !== 'chunk' || !chunk.fileName.includes(LOAD_SHARE_TAG)) continue;
    let ast: ReturnType<typeof parseAst>;
    try {
      ast = parseAst(chunk.code);
    } catch {
      continue;
    }
    const edits: { start: number; end: number; replacement: string }[] = [];
    const deferredSources = new Set<string>();
    forEachAstNode(ast, (node) => {
      if (node.type !== 'ImportExpression') return;
      const source = getModuleSource(node.source);
      if (source) deferredSources.add(source);
    });
    const retainedImports = new Set<string>();
    const removedImports = new Set<string>();
    for (const node of ast.body) {
      if (node.type !== 'ImportDeclaration') continue;
      const source = getModuleSource(node.source);
      if (!source) continue;
      const targetName = path.posix.normalize(
        path.posix.join(path.posix.dirname(chunk.fileName), source)
      );
      const [specifier] = node.specifiers;
      const exported = specifier?.type === 'ImportSpecifier' && specifier.imported;
      const target = bundle[targetName];
      if (
        !source.includes(PREBUILD_TAG) ||
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

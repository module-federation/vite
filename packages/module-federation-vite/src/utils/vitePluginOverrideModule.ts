
import { createFilter } from '@rollup/pluginutils';
import { walk } from 'estree-walker';
import MagicString from 'magic-string';
import { Plugin, UserConfig } from "vite";

export function overrideModule(options: { override?: string[], include?: string | string[], exclude?: string | string[] } = {}): Plugin {
  let { override: _override = [], include, exclude } = options;
  const override = new Set(_override);
  const filterFunction = createFilter(include, exclude);
  const alias: { [key: string]: string } = {};
  [...override].forEach((key) => {
    alias["__overrideModule__" + key] = require.resolve(`an-empty-js-file`) + `?__overrideModule__=${encodeURIComponent(key)}`;
  });

  return {
    name: 'overrideModule',
    enforce: "post",
    config(config: UserConfig) {
      if (!config.optimizeDeps) config.optimizeDeps = {};
      if (!config.optimizeDeps.needsInterop) config.optimizeDeps.needsInterop = [];
      Object.keys(alias).forEach(key => {
        config.optimizeDeps?.needsInterop?.push(key);
      });
      config.optimizeDeps.needsInterop.push("an-empty-js-file");
      (config.resolve as any).alias.push(...Object.keys(alias).map(key => ({ find: key, replacement: alias[key] })))
    },
    resolveId(id: string): string {
      return alias[id];
    },
    transform: {
      handler(code: string, id: string): { code: string, map: any } | null {
        if (!filterFunction(id)) return null;
        let ast: any;
        try {
          ast = (this as any).parse(code, {
            allowReturnOutsideFunction: true
          });
        } catch (e) {
          throw new Error(`${id}: ${e}`);
        }

        const s = new MagicString(code);

        walk(ast, {
          enter(node: any) {
            const replaceIfMatch = (sourceNode: any) => {
              if (sourceNode && sourceNode.value) {
                if (override.has(sourceNode.value)) {
                  const start = sourceNode.start + 1; // Skip the opening quote
                  const end = sourceNode.end - 1; // Skip the closing quote
                  s.overwrite(start, end, "__overrideModule__" + sourceNode.value);
                }
              }
            };

            if (node.type === 'ImportDeclaration') {
              replaceIfMatch(node.source);
            }

            if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
              replaceIfMatch(node.source);
            }

            if (
              node.type === 'CallExpression' &&
              node.callee.type === 'Import' &&
              node.arguments.length &&
              node.arguments[0].type === 'Literal'
            ) {
              replaceIfMatch(node.arguments[0]);
            }

            if (
              node.type === 'CallExpression' &&
              node.callee.name === 'require' &&
              node.arguments.length &&
              node.arguments[0].type === 'Literal'
            ) {
              replaceIfMatch(node.arguments[0]);
            }
          }
        });

        return {
          code: s.toString(),
          map: s.generateMap({ hires: true })
        };
      }
    },
  }
}

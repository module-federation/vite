/**
 * Solve the problem that dev mode dependency prebunding does not support top-level await syntax
 */
import { createFilter } from '@rollup/pluginutils';
import { walk } from 'estree-walker';
import MagicString from 'magic-string';
import { Plugin } from 'vite';

export function PluginDevProxyModuleTopLevelAwait(): Plugin {
  const filterFunction = createFilter();
  return {
    name: 'dev-proxy-module-top-level-await',
    apply: 'serve',
    transform(code: string, id: string): { code: string; map: any } | null {
      if (!code.includes('/*mf top-level-await placeholder replacement mf*/')) {
        return null;
      }
      if (!filterFunction(id)) return null;
      let ast: any;
      try {
        ast = (this as any).parse(code, {
          allowReturnOutsideFunction: true,
        });
      } catch (e) {
        throw new Error(`${id}: ${e}`);
      }

      const magicString = new MagicString(code);

      walk(ast, {
        enter(node: any) {
          if (node.type === 'ExportNamedDeclaration' && node.specifiers) {
            const exportSpecifiers = node.specifiers.map(
              (specifier: any) => specifier.exported.name
            );
            const proxyStatements = exportSpecifiers
              .map(
                (name: string) => `
              const __mfproxy__await${name} = await ${name}();
              const __mfproxy__${name} = () => __mfproxy__await${name};
            `
              )
              .join('\n');
            const exportStatements = exportSpecifiers
              .map((name: string) => `__mfproxy__${name} as ${name}`)
              .join(', ');

            const start = node.start;
            const end = node.end;
            const replacement = `${proxyStatements}\nexport { ${exportStatements} };`;

            magicString.overwrite(start, end, replacement);
          }

          if (node.type === 'ExportDefaultDeclaration') {
            const declaration = node.declaration;
            const start = node.start;
            const end = node.end;

            let proxyStatement;
            let exportStatement = 'default';

            if (declaration.type === 'Identifier') {
              // example: export default foo;
              proxyStatement = `
                const __mfproxy__awaitdefault = await ${declaration.name}();
                const __mfproxy__default = __mfproxy__awaitdefault;
              `;
            } else if (
              declaration.type === 'CallExpression' ||
              declaration.type === 'FunctionDeclaration'
            ) {
              // example: export default someFunction();
              const declarationCode = code.slice(declaration.start, declaration.end);
              proxyStatement = `
                const __mfproxy__awaitdefault = await (${declarationCode});
                const __mfproxy__default = __mfproxy__awaitdefault;
              `;
            } else {
              // other
              proxyStatement = `
                const __mfproxy__awaitdefault = await (${code.slice(declaration.start, declaration.end)});
                const __mfproxy__default = __mfproxy__awaitdefault;
              `;
            }

            const replacement = `${proxyStatement}\nexport { __mfproxy__default as ${exportStatement} };`;

            magicString.overwrite(start, end, replacement);
          }
        },
      });
      return {
        code: magicString.toString(),
        map: magicString.generateMap({ hires: true }),
      };
    },
  };
}

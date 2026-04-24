/**
 * Solve the problem that dev mode dependency prebunding does not support top-level await syntax
 */
import { createFilter } from '@rollup/pluginutils';
import MagicString from 'magic-string';
import type { Plugin } from 'vite';
import { loadWalk } from '../utils/loadWalk';
import { createModuleFederationError } from '../utils/logger';
import { hasPackageDependency } from '../utils/packageUtils';

export function PluginDevProxyModuleTopLevelAwait(): Plugin {
  const filterFunction = createFilter();
  const processedFlag = '/* already-processed-by-dev-proxy-module-top-level-await */';

  return {
    name: 'dev-proxy-module-top-level-await',
    apply: 'serve',
    async transform(code: string, id: string): Promise<{ code: string; map: any } | null> {
      if (code.includes(processedFlag)) {
        return null;
      }
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
        throw createModuleFederationError(`${id}: ${e}`);
      }

      const magicString = new MagicString(code);
      const walk = await loadWalk();
      const isVinext = hasPackageDependency('vinext');
      const defaultExportExpression = isVinext
        ? '(__mfproxy__awaitdefault?.default ?? __mfproxy__awaitdefault)'
        : '__mfproxy__awaitdefault';

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
                const __mfproxy__default = ${defaultExportExpression};
              `;
            } else if (
              declaration.type === 'CallExpression' ||
              declaration.type === 'FunctionDeclaration'
            ) {
              // example: export default someFunction();
              const declarationCode = code.slice(declaration.start, declaration.end);
              proxyStatement = `
                const __mfproxy__awaitdefault = await (${declarationCode});
                const __mfproxy__default = ${defaultExportExpression};
              `;
            } else {
              // other
              proxyStatement = `
                const __mfproxy__awaitdefault = await (${code.slice(declaration.start, declaration.end)});
                const __mfproxy__default = ${defaultExportExpression};
              `;
            }

            const replacement = `${proxyStatement}\nexport { __mfproxy__default as ${exportStatement} };`;

            magicString.overwrite(start, end, replacement);
          }
        },
      });
      const transformedCode = magicString.toString();
      return {
        code: `${processedFlag}\n${transformedCode}`,
        map: magicString.generateMap({ hires: true }),
      };
    },
  };
}

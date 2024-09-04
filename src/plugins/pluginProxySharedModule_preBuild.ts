import { createFilter } from '@rollup/pluginutils';
import { defu } from 'defu';
import { walk } from 'estree-walker';
import MagicString from 'magic-string';
import { Plugin, UserConfig, WatchOptions } from 'vite';
import { getNormalizeModuleFederationOptions, NormalizedShared } from '../utils/normalizeModuleFederationOptions';
import { packageNameDecode } from '../utils/packageNameUtils';
import { PromiseStore } from "../utils/PromiseStore";
import { wrapManualChunks } from '../utils/wrapManualChunks';
import { addShare, generateLocalSharedImportMap, getLoadShareModulePath, getLocalSharedImportMapPath, LOAD_SHARE_TAG, PREBUILD_TAG, writeLoadShareModule, writeLocalSharedImportMap, writePreBuildLibPath } from '../virtualModules';
export function proxySharedModule(
  options: { shared?: NormalizedShared; include?: string | string[]; exclude?: string | string[] }
): Plugin[] {
  let { shared = {}, include, exclude } = options;
  const filterFunction = createFilter(include, exclude);
  const { name } = getNormalizeModuleFederationOptions()
  return [
    {
      name: "generateLocalSharedImportMap",
      enforce: "post",
      resolveId(id) {
        if (id.includes(getLocalSharedImportMapPath()))
          return id
      },
      load(id) {
        if (id.includes(getLocalSharedImportMapPath())) {
          return generateLocalSharedImportMap()
        }
      },
      transform(code, id) {
        if (id.includes(getLocalSharedImportMapPath())) {
          return generateLocalSharedImportMap()
        }
      }
    },
    {
      name: 'proxyPreBuildShared',
      enforce: 'post',
      config(config: UserConfig, { command }) {
        if (!config.build) config.build = {};
        if (!config.build.rollupOptions) config.build.rollupOptions = {};
        let { rollupOptions } = config.build;
        if (!rollupOptions.output) rollupOptions.output = {};
        wrapManualChunks(config.build.rollupOptions.output, (id: string) => {
          // https://github.com/module-federation/vite/issues/40#issuecomment-2311434503
          if (id.includes('/preload-helper.js')) {
            return "preload-helper"
          }
          if (id.includes("node_modules/@module-federation/runtime")) {
            return "@module-federation/runtime"
          }
        });
        ; (config.resolve as any).alias.push(
          ...Object.keys(shared).map((key) => {
            const pattern = key.endsWith("/") ? `(^${key.replace(/\/$/, "")}(\/.+)?$)` : `(^${key}$)`
            return {
              // Intercept all shared requests and proxy them to loadShare
              find: new RegExp(pattern), replacement: "$1", customResolver(source: string, importer: string) {
                const loadSharePath = getLoadShareModulePath(source)
                config?.optimizeDeps?.needsInterop?.push(loadSharePath);
                writeLoadShareModule(source, shared[key], command)
                writePreBuildLibPath(source)
                addShare(source)
                writeLocalSharedImportMap()
                return (this as any).resolve(loadSharePath)
              }
            }
          })
        );
        const savePrebuild = new PromiseStore<string>()

          ; (config.resolve as any).alias.push(
            ...Object.keys(shared).map((key) => {
              return command === "build" ?
                {
                  find: new RegExp(`(.*${PREBUILD_TAG}(.+))`), replacement: function ($1: string) {
                    $1 = $1.replace(/\.[^.]+$/, "")
                    const pkgName = packageNameDecode($1.split(PREBUILD_TAG)[1])
                    return packageNameDecode(pkgName)
                  }
                } :
                {
                  find: new RegExp(`(.*${PREBUILD_TAG}(.+))`), replacement: "$1", async customResolver(source: string, importer: string) {
                    source = source.replace(/\.[^.]+$/, "")
                    const pkgName = packageNameDecode(source.split(PREBUILD_TAG)[1])
                    if (importer.includes(LOAD_SHARE_TAG)) {
                      // save pre-bunding module id
                      savePrebuild.set(pkgName, (this as any).resolve(pkgName).then((item: any) => item.id))
                    }
                    // Fix localSharedImportMap import id
                    return await (this as any).resolve(await savePrebuild.get(pkgName))
                  }
                }
            })
          );
      },
    },
    {
      name: "watchLocalSharedImportMap",
      apply: "serve",
      config(config) {
        config.optimizeDeps = defu(config.optimizeDeps, {
          exclude: [getLocalSharedImportMapPath()]
        });
        config.server = defu(config.server, {
          watch: {
            ignored: [],
          }
        });
        const watch = config.server.watch as WatchOptions
        watch.ignored = [].concat(watch.ignored as any);
        watch.ignored.push(`!**${getLocalSharedImportMapPath()}**`);
      },
    },
    {
      name: "prebuild-top-level-await",
      apply: "serve",
      transform(code: string, id: string): { code: string; map: any } | null {
        if (!(code.includes("/*mf top-level-await placeholder replacement mf*/"))) {
          return null
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
              const exportSpecifiers = node.specifiers.map((specifier: any) => specifier.exported.name);
              const proxyStatements = exportSpecifiers.map((name: string) => `
                const __mfproxy__await${name} = await ${name}();
                const __mfproxy__${name} = () => __mfproxy__await${name};
              `).join('\n');
              const exportStatements = exportSpecifiers.map((name: string) => `__mfproxy__${name} as ${name}`).join(', ');

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
              } else if (declaration.type === 'CallExpression' || declaration.type === 'FunctionDeclaration') {
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
          }
        });
        return {
          code: magicString.toString(),
          map: magicString.generateMap({ hires: true }),
        };
      },
    }
  ]
}

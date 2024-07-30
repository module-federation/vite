const { walk } = require('estree-walker');
const MagicString = require('magic-string');
const path = require("path")
const { createFilter } = require('@rollup/pluginutils');
// const emptyPath = path.resolve(__dirname, "./empty.js")
const matchMap = {}

exports.matchMap = matchMap

exports.matchModule = function matchModule(moduleName, id) {
  const index = matchMap[moduleName]
  return id.indexOf(`__overrideModule__=${index}`) > -1 || id.indexOf(`__overrideModule__${moduleName}`) > -1
}

exports.overrideModule = function overrideModule(options = {}) {
  let { override = [], include, exclude } = options;
  override = new Set(override)
  const filterFunction = createFilter(include, exclude);
  const alias = {};
  ;[...override].forEach((key) => {
    // matchMap["__overrideModule__" + override[key]] = moduleIndex
    alias["__overrideModule__" + key] = require.resolve(`an-empty-js-file`) + `?__overrideModule__=${encodeURIComponent(key)}`
  })
  // console.log(1111222, alias)
  return [
    {
      name: 'overrideModule',
      enforce: "post",
      config(config) {
        if (!config.optimizeDeps) config.optimizeDeps = {}
        if (!config.optimizeDeps.needsInterop) config.optimizeDeps.needsInterop = []
        Object.keys(alias).forEach(key => {
          config.optimizeDeps.needsInterop.push(key)
        })
        config.optimizeDeps.needsInterop.push("an-empty-js-file")
        config.resolve.alias.push(...Object.keys(alias).map(key => ({find: key, replacement: alias[key]})))
      },
      resolveId(id) {
        return alias[id]
      },
      transform: {
        handler(code, id) {
          if (!filterFunction(id)) return null;
          let ast;
          try {
            ast = this.parse(code, {
              allowReturnOutsideFunction: true
            });
          } catch (e) {
            throw new Error(`${id}: ${e}`);
          }
    
          const s = new MagicString(code);
    
          walk(ast, {
            enter(node) {
              const replaceIfMatch = (sourceNode) => {
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
  ];
}

/**
 * 
 * @param {*} moduleName sharedvue
 * @param {*} id .vite/deps/__overrideModule__sharedvue.js || empty.js?__overrideModule=1
 */
export function matchModule(moduleName, id) {

}


// const override = {
//   vue: "sharedvue",
//   react: "sharedreact"
// }
// const alias = {
//   "__overrideModule__sharedvue": "empty.js?__overrideModule=0",
//   "__overrideModule__sharedreact": "empty.js?__overrideModule=1"
// }
// const matchMap = {
//   "sharedvue": "0",
//   "sharedreact": "1"
// }
export function overrideMap (override) {
  const alias = {}
  Object.keys(override).forEach((key) => {
    aliasMap[override[key]] = moduleIndex
    alias[override[key]] = `${emptyPath}?__overrideModule__=${moduleIndex}`
    moduleIndex++
  })
  return {
    alias: 
  }
}
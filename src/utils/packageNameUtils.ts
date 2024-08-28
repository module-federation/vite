/**
 * 转意符释意: 
 *  以 __${映射}__ 来做转换, _和$都是npm所不允许的包名符号, 但可以作为变量名
 *  @ => 1
 *  / => 2
 *  - => 3
 *  . => 4
 */

/**
 * @param {*} name "@scope/xx-xx.xx" => "__$1__scope__$2__xx__$3__xx$__4__xx"
 */
export function packageNameEncode(name: string) {
  if (typeof name !== "string") throw new Error("需传入字符串包名")
  return name
    .replace(/\@/g, "__$1__")
    .replace(/\//g, "__$2__")
    .replace(/\-/g, "__$3__")
    .replace(/\./g, "__$4__")
}

/**
 * @param {*} global "__$1__scope__$2__xx__$3__xx$__4__xx" => "@scope/xx-xx.xx"
 */
export function packageNameDecode(global: string) {
  if (typeof global !== "string") throw new Error("需传入字符串全局变量名")
  return global
    .replace(/\_\_\$1\_\_/g, "@")
    .replace(/\_\_\$2\_\_/g, "/")
    .replace(/\_\_\$3\_\_/g, "-")
    .replace(/\_\_\$4\_\_/g, ".")
}

export function removePathFromNpmPackage(packageString: string): string {
  // 匹配npm包名的正则表达式，忽略路径部分
  const regex = /^(?:@[^/]+\/)?[^/]+/;
  
  // 使用正则表达式匹配并提取包名
  const match = packageString.match(regex);
  
  // 返回匹配到的包名，如果没有匹配到则返回原字符串
  return match ? match[0] : packageString;
}
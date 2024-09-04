/**
 * Escaping rules:
 * Convert using the format __${mapping}__, where _ and $ are not allowed in npm package names but can be used in variable names.
 *  @ => 1
 *  / => 2
 *  - => 3
 *  . => 4
 */

/**
 * @param {*} name "@scope/xx-xx.xx" => "__$1__scope__$2__xx__$3__xx$__4__xx"
 */
export function packageNameEncode(name: string) {
  if (typeof name !== "string") throw new Error("A string package name is required");
  return name
    .replace(/\@/g, "__$1__")
    .replace(/\//g, "__$2__")
    .replace(/\-/g, "__$3__")
    .replace(/\./g, "__$4__");
}

/**
 * @param {*} global "__$1__scope__$2__xx__$3__xx$__4__xx" => "@scope/xx-xx.xx"
 */
export function packageNameDecode(global: string) {
  if (typeof global !== "string") throw new Error("A string global variable name is required");
  return global
    .replace(/\_\_\$1\_\_/g, "@")
    .replace(/\_\_\$2\_\_/g, "/")
    .replace(/\_\_\$3\_\_/g, "-")
    .replace(/\_\_\$4\_\_/g, ".");
}

export function removePathFromNpmPackage(packageString: string): string {
  // Regular expression to match npm package name, ignoring path parts
  const regex = /^(?:@[^/]+\/)?[^/]+/;

  // Use regular expression to match and extract the package name
  const match = packageString.match(regex);

  // Return the matched package name or the original string if no match is found
  return match ? match[0] : packageString;
}

export function getExtFromNpmPackage(packageString: string) {
  const pkgName = removePathFromNpmPackage(packageString)
  const subpath = packageString.replace(pkgName, "")
  const parts = subpath.split('.');
  const ext = parts.length > 1 ? "." + parts.pop() : undefined;
  return ext
}
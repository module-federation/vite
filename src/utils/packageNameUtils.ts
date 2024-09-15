/**
 * Escaping rules:
 * Convert using the format __${mapping}__, where _ and $ are not allowed in npm package names but can be used in variable names.
 *  @ => 1
 *  / => 2
 *  - => 3
 *  . => 4
 */

/**
 * Encodes a package name into a valid file name.
 * @param {string} name - The package name, e.g., "@scope/xx-xx.xx".
 * @returns {string} - The encoded file name.
 */
export function packageNameEncode(name: string) {
  if (typeof name !== "string") throw new Error("A string package name is required");
  return name
    .replace(/@/g, "_mf_0_")
    .replace(/\//g, "_mf_1_")
    .replace(/-/g, "_mf_2_")
    .replace(/\./g, "_mf_3_");
}

/**
 * Decodes an encoded file name back to the original package name.
 * @param {string} encoded - The encoded file name, e.g., "_mf_0_scope_mf_1_xx_mf_2_xx_mf_3_xx".
 * @returns {string} - The decoded package name.
 */
export function packageNameDecode(encoded: string) {
  if (typeof encoded !== "string") throw new Error("A string encoded file name is required");
  return encoded
    .replace(/_mf_0_/g, "@")
    .replace(/_mf_1_/g, "/")
    .replace(/_mf_2_/g, "-")
    .replace(/_mf_3_/g, ".");
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
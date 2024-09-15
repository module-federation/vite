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
export declare function packageNameEncode(name: string): string;
/**
 * Decodes an encoded file name back to the original package name.
 * @param {string} encoded - The encoded file name, e.g., "_mf_0_scope_mf_1_xx_mf_2_xx_mf_3_xx".
 * @returns {string} - The decoded package name.
 */
export declare function packageNameDecode(encoded: string): string;
export declare function removePathFromNpmPackage(packageString: string): string;
export declare function getExtFromNpmPackage(packageString: string): string | undefined;

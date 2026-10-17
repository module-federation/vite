/**
 * Turns `name` (e.g. a federation name like `@scope/app-1`) into a string that
 * can be appended to a JavaScript identifier.
 */
export function toIdentifierSuffix(name: string): string {
  return name.replace(/[^A-Za-z0-9_$]/g, '_');
}

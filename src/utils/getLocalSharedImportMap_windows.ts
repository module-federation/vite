/**
 * https://github.com/module-federation/vite/issues/68
 */
import { mkdirSync, writeFileSync } from 'fs';
import path from 'pathe';
import { getNormalizeModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { packageNameEncode } from '../utils/packageNameUtils';


export function getRemoteEntryPath_windows() {
  const { name } = getNormalizeModuleFederationOptions()
  return path.resolve(".__mf__win", packageNameEncode(name), "remoteEntry")
}
export function writeRemoteEntry_windows(content: string) {
  const localSharedImportMapId = getRemoteEntryPath_windows()
  createFile(localSharedImportMapId + ".js", "\n// Windows temporarily needs this file, https://github.com/module-federation/vite/issues/68\n" + content)
}
function createFile(filePath: string, content: string) {
  const dir = path.dirname(filePath);

  mkdirSync(dir, { recursive: true });

  writeFileSync(filePath, content);
}

/**
 * https://github.com/module-federation/vite/issues/68
 */
import { mkdirSync, writeFileSync } from 'fs';
import path from 'pathe';
import { getNormalizeModuleFederationOptions } from './normalizeModuleFederationOptions';
import { packageNameEncode } from './packageNameUtils';

export function getLocalSharedImportMapPath_temp() {
  const { name } = getNormalizeModuleFederationOptions();
  return path.resolve('.__mf__temp', packageNameEncode(name), 'localSharedImportMap');
}
export function writeLocalSharedImportMap_temp(content: string) {
  const localSharedImportMapId = getLocalSharedImportMapPath_temp();
  createFile(
    localSharedImportMapId + '.js',
    '\n// Windows temporarily needs this file, https://github.com/module-federation/vite/issues/68\n' +
      content
  );
}
function createFile(filePath: string, content: string) {
  const dir = path.dirname(filePath);

  mkdirSync(dir, { recursive: true });

  writeFileSync(filePath, content);
}

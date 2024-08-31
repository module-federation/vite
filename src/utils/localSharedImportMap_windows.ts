/**
 * https://github.com/module-federation/vite/issues/68
 */
import { mkdirSync, writeFileSync } from 'fs';
import path from 'pathe';
import VirtualModule from './VirtualModule';
import { getNormalizeModuleFederationOptions } from './normalizeModuleFederationOptions';
import { packageNameEncode } from './packageNameUtils';


export function getLocalSharedImportMapPath_windows(virtualModule: VirtualModule) {
  const { name } = getNormalizeModuleFederationOptions()
  return virtualModule.getPath().replace("node_modules", ".__mf__win/" + packageNameEncode(name))
}
export function writeLocalSharedImportMap_windows(virtualModule: VirtualModule, content: string) {
  const localSharedImportMapId = getLocalSharedImportMapPath_windows(virtualModule)
  createFile(localSharedImportMapId + ".js", "\n// Windows temporarily needs this file, https://github.com/module-federation/vite/issues/68\n" + content)
}
function createFile(filePath: string, content: string) {
  const dir = path.dirname(filePath);

  mkdirSync(dir, { recursive: true });

  writeFileSync(filePath, content);
}

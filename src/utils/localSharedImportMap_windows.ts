/**
 * https://github.com/module-federation/vite/issues/68
 */
import { mkdirSync, writeFileSync } from 'fs';
import path from 'pathe';
import VirtualModule from './VirtualModule';


export function getLocalSharedImportMapPath_windows(virtualModule: VirtualModule) {
  return virtualModule.getPath().replace("node_modules", ".__mf__win")
}
export function writeLocalSharedImportMap_windows(virtualModule: VirtualModule, content: string) {
  const localSharedImportMapId = getLocalSharedImportMapPath_windows(virtualModule)
  createFile(localSharedImportMapId + ".js", "\n// Windows temporarily needs this file, https://github.com/module-federation/vite/issues/68\n" + content)
}
/**
 * 创建文件，确保前面的目录存在
 * @param {string} filePath - 文件的完整路径
 * @param {string} content - 写入文件的内容
 */
function createFile(filePath: string, content: string) {
  // 获取文件的目录路径
  const dir = path.dirname(filePath);

  // 递归创建目录（如果不存在的话）
  mkdirSync(dir, { recursive: true });

  // 创建文件并写入内容
  writeFileSync(filePath, content);
}

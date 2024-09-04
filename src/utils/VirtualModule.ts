import { existsSync, mkdirSync, writeFile, writeFileSync } from "fs";
import { dirname, join, parse, resolve } from "pathe";
import { packageNameEncode } from "../utils/packageNameUtils";
import { getNormalizeModuleFederationOptions } from "./normalizeModuleFederationOptions";

const nodeModulesDir = function findNodeModulesDir(startDir = process.cwd()) {
  let currentDir = startDir;

  while (currentDir !== parse(currentDir).root) {
    const nodeModulesPath = join(currentDir, 'node_modules');
    if (existsSync(nodeModulesPath)) {
      return nodeModulesPath;
    }
    currentDir = dirname(currentDir);
  }

  return "";
}()
export const virtualPackageName = "__mf__virtual"
if (!existsSync(resolve(nodeModulesDir, virtualPackageName))) {
  mkdirSync(resolve(nodeModulesDir, virtualPackageName))
}
writeFileSync(resolve(nodeModulesDir, virtualPackageName, "empty.js"), "")
writeFileSync(resolve(nodeModulesDir, virtualPackageName, "package.json"), JSON.stringify({
  name: virtualPackageName,
  main: "empty.js"
}))

/**
 * Physically generate files as virtual modules under node_modules/__mf__virtual/*
 */
export default class VirtualModule {
  originName: string
  inited: boolean = false
  ext: string
  constructor(name: string, ext: string = ".js") {
    this.originName = name
    this.ext = ext
  }
  getPath() {
    return resolve(nodeModulesDir, this.getImportId())
  }
  getImportId() {
    const { name } = getNormalizeModuleFederationOptions()

    return `${virtualPackageName}/${packageNameEncode(name)}-${packageNameEncode(this.originName)}${this.ext}`
  }
  writeSync(code: string, force?: boolean) {
    if (!force && this.inited) return
    if (!this.inited) {
      this.inited = true
    }
    writeFileSync(this.getPath(), code)
  }
  write(code: string) {
    writeFile(this.getPath(), code, function () { })
  }

}
import { mkdirSync, writeFile, writeFileSync } from "fs";
import { resolve } from "pathe";
import { packageNameEncode } from "../utils/packageNameUtils";

const nodeModulesDir = resolve("./node_modules")
export const virtualPackageName = "__mf__virtual"
try {
  mkdirSync(resolve(nodeModulesDir, virtualPackageName))
} catch (e) { }
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
  constructor(name: string) {
    this.originName = name
  }
  getPath() {
    return resolve(nodeModulesDir, this.getImportId())
  }
  getImportId() {
    return `${virtualPackageName}/${packageNameEncode(this.originName)}`
  }
  writeSync(code: string) {
    writeFileSync(this.getPath() + ".js", code)
  }
  write(code: string) {
    writeFile(this.getPath() + ".js", code, function () { })
  }

}
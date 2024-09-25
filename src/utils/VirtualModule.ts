import { existsSync, mkdirSync, writeFile, writeFileSync } from 'fs';
import { dirname, join, parse, resolve } from 'pathe';
import { packageNameDecode, packageNameEncode } from '../utils/packageNameUtils';
import { getNormalizeModuleFederationOptions } from './normalizeModuleFederationOptions';

const nodeModulesDir = (function findNodeModulesDir(startDir = process.cwd()) {
  let currentDir = startDir;

  while (currentDir !== parse(currentDir).root) {
    const nodeModulesPath = join(currentDir, 'node_modules');
    if (existsSync(nodeModulesPath)) {
      return nodeModulesPath;
    }
    currentDir = dirname(currentDir);
  }

  return '';
})();
export const virtualPackageName = '__mf__virtual';
if (!existsSync(resolve(nodeModulesDir, virtualPackageName))) {
  mkdirSync(resolve(nodeModulesDir, virtualPackageName));
}
writeFileSync(resolve(nodeModulesDir, virtualPackageName, 'empty.js'), '');
writeFileSync(
  resolve(nodeModulesDir, virtualPackageName, 'package.json'),
  JSON.stringify({
    name: virtualPackageName,
    main: 'empty.js',
  })
);

const patternMap: {
  [tag: string]: RegExp;
} = {};

const cacheMap: {
  [tag: string]: {
    [name: string]: VirtualModule;
  };
} = {};
/**
 * Physically generate files as virtual modules under node_modules/__mf__virtual/*
 */
export default class VirtualModule {
  name: string;
  tag: string;
  suffix: string;
  inited: boolean = false;
  static findModule(tag: string, str: string = ''): VirtualModule | undefined {
    if (!patternMap[tag])
      patternMap[tag] = new RegExp(`(.*${packageNameEncode(tag)}(.+?)${packageNameEncode(tag)}.*)`);
    const moduleName = (str.match(patternMap[tag]) || [])[2];
    if (moduleName)
      return cacheMap[tag][packageNameDecode(moduleName)] as VirtualModule | undefined;
    return undefined;
  }
  constructor(name: string, tag: string = '__mf_v__', suffix = '') {
    this.name = name;
    this.tag = tag;
    this.suffix = suffix || name.split('.').slice(1).pop()?.replace(/(.)/, '.$1') || '.js';
    if (!cacheMap[this.tag]) cacheMap[this.tag] = {};
    cacheMap[this.tag][this.name] = this;
  }
  getPath() {
    return resolve(nodeModulesDir, this.getImportId());
  }
  getImportId() {
    const { name: mfName } = getNormalizeModuleFederationOptions();

    return `${virtualPackageName}/${packageNameEncode(`${mfName}${this.tag}${this.name}${this.tag}`)}${this.suffix}`;
  }
  writeSync(code: string, force?: boolean) {
    if (!force && this.inited) return;
    if (!this.inited) {
      this.inited = true;
    }
    writeFileSync(this.getPath(), code);
  }
  write(code: string) {
    writeFile(this.getPath(), code, function () {});
  }
}

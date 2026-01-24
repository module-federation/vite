import { existsSync, mkdirSync, writeFile, writeFileSync } from 'fs';
import { basename, join, resolve } from 'pathe';
import { packageNameDecode, packageNameEncode } from '../utils/packageNameUtils';
import { getNormalizeModuleFederationOptions } from './normalizeModuleFederationOptions';

// Cache root path
let rootDir: string | undefined;

// Cache nodeModulesDir result to avoid repeated calculations
let cachedNodeModulesDir: string | undefined;

function getNodeModulesDir() {
  if (cachedNodeModulesDir) {
    return cachedNodeModulesDir;
  }
  const targetRoot = rootDir || process.cwd();
  const nodeModulesPath = join(targetRoot, 'node_modules');
  if (!existsSync(nodeModulesPath)) {
    mkdirSync(nodeModulesPath, { recursive: true });
  }
  cachedNodeModulesDir = nodeModulesPath;
  return cachedNodeModulesDir;
}

export function getSuffix(name: string): string {
  const base = basename(name);
  const dotIndex = base.lastIndexOf('.');

  if (dotIndex > 0 && dotIndex < base.length - 1) {
    return base.slice(dotIndex);
  }

  return '.js';
}

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
export function assertModuleFound(tag: string, str: string = ''): VirtualModule {
  const module = VirtualModule.findModule(tag, str);
  if (!module) {
    throw new Error(
      `Module Federation shared module '${str}' not found. Please ensure it's installed as a dependency in your package.json.`
    );
  }
  return module;
}

export default class VirtualModule {
  name: string;
  tag: string;
  suffix: string;
  inited: boolean = false;

  /**
   * Set the root path for finding node_modules
   * @param root - Root path
   */
  static setRoot(root: string) {
    rootDir = root;
    // Reset cache to ensure using the new root path
    cachedNodeModulesDir = undefined;
  }

  /**
   * Ensure virtual package directory exists
   */
  static ensureVirtualPackageExists() {
    const nodeModulesDir = getNodeModulesDir();
    const { virtualModuleDir } = getNormalizeModuleFederationOptions();
    const virtualPackagePath = resolve(nodeModulesDir, virtualModuleDir);

    if (!existsSync(virtualPackagePath)) {
      mkdirSync(virtualPackagePath, { recursive: true });
      writeFileSync(resolve(virtualPackagePath, 'empty.js'), '');
    }
  }

  static getVirtualModuleDirPath() {
    const nodeModulesDir = getNodeModulesDir();
    const { virtualModuleDir } = getNormalizeModuleFederationOptions();
    return resolve(nodeModulesDir, virtualModuleDir);
  }

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
    this.suffix = suffix || getSuffix(name);
    if (!cacheMap[this.tag]) cacheMap[this.tag] = {};
    cacheMap[this.tag][this.name] = this;
  }

  getPath() {
    return resolve(getNodeModulesDir(), this.getImportId());
  }

  getImportId() {
    const { name: mfName, virtualModuleDir } = getNormalizeModuleFederationOptions();
    return `${virtualModuleDir}/${packageNameEncode(`${mfName}${this.tag}${this.name}${this.tag}`)}${this.suffix}`;
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

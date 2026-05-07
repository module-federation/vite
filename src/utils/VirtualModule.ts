import { basename } from 'pathe';
import { packageNameDecode, packageNameEncode } from '../utils/packageUtils';
import { createModuleFederationError } from './logger';
import { getNormalizeModuleFederationOptions } from './normalizeModuleFederationOptions';

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

export function assertModuleFound(tag: string, str: string = ''): VirtualModule {
  const module = VirtualModule.findModule(tag, str);
  if (!module) {
    throw createModuleFederationError(
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
  code: string | undefined;

  static findModule(tag: string, str: string = ''): VirtualModule | undefined {
    if (!patternMap[tag])
      patternMap[tag] = new RegExp(`(.*${packageNameEncode(tag)}(.+?)${packageNameEncode(tag)}.*)`);
    const moduleName = (str.match(patternMap[tag]) || [])[2];
    if (moduleName)
      return cacheMap[tag][packageNameDecode(moduleName)] as VirtualModule | undefined;
    return undefined;
  }

  static findById(id: string): VirtualModule | undefined {
    const normalized = id
      .replace(/^\0/, '')
      .replace(/^\/@id\//, '')
      .replace(/^__x00__/, '');
    for (const modules of Object.values(cacheMap)) {
      for (const module of Object.values(modules)) {
        if (module.getImportId() === normalized) return module;
      }
    }
    return undefined;
  }

  constructor(name: string, tag: string = '__mf_v__', suffix = '') {
    this.name = name;
    this.tag = tag;
    this.suffix = suffix || getSuffix(name);
    if (!cacheMap[this.tag]) cacheMap[this.tag] = {};
    cacheMap[this.tag][this.name] = this;
  }

  getImportId() {
    const { internalName: mfName } = getNormalizeModuleFederationOptions();
    return `virtual:mf:${packageNameEncode(`${mfName}${this.tag}${this.name}${this.tag}`)}${this.suffix}`;
  }

  getResolvedId() {
    return `\0${this.getImportId()}`;
  }

  writeSync(code: string, force?: boolean) {
    if (!force && this.inited) return;
    if (!this.inited) {
      this.inited = true;
    }
    this.code = code;
  }

  write(code: string) {
    this.writeSync(code, true);
  }
}

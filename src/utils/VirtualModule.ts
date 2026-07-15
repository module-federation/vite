import { basename } from 'node:path';
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

// resolveId is called for every module. Keep virtual-id lookup O(1) instead of
// scanning all virtual modules on every call.
const idCacheMap: Record<string, VirtualModule> = {};

export const VITE_ID_PREFIX = '/@id/';
export const VITE_NULL_BYTE_PLACEHOLDER = '__x00__';
export const VITE_ENCODED_NULL_BYTE_PREFIX = `${VITE_ID_PREFIX}${VITE_NULL_BYTE_PLACEHOLDER}`;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createViteEncodedIdPrefixRegExp(sourcePrefix = ''): RegExp {
  return new RegExp(`^(?:${escapeRegExp(VITE_ENCODED_NULL_BYTE_PREFIX)})?${sourcePrefix}`);
}

export function toViteEncodedId(id: string): string {
  return `${VITE_ENCODED_NULL_BYTE_PREFIX}${id}`;
}

export function decodeViteId(id: string): string {
  if (!id.startsWith(VITE_ID_PREFIX)) return id;
  const viteId = id.slice(VITE_ID_PREFIX.length);
  return viteId.startsWith(VITE_NULL_BYTE_PLACEHOLDER)
    ? `\0${viteId.slice(VITE_NULL_BYTE_PLACEHOLDER.length)}`
    : viteId;
}

export function assertModuleFound(tag: string, str: string = ''): VirtualModule {
  const module = VirtualModule.findById(str) ?? VirtualModule.findModule(tag, str);
  if (!module) {
    throw createModuleFederationError(
      `Module Federation shared module '${str}' not found. Please ensure it's installed as a dependency in your package.json.`
    );
  }
  return module;
}

export function normalizeVirtualModuleId(id: string): string {
  const decoded = decodeViteId(id).replace(/^\0+/, '');
  const queryIndex = decoded.indexOf('?');
  const hashIndex = decoded.indexOf('#');
  const endIndex =
    queryIndex === -1 ? hashIndex : hashIndex === -1 ? queryIndex : Math.min(queryIndex, hashIndex);
  return endIndex === -1 ? decoded : decoded.slice(0, endIndex);
}

export default class VirtualModule {
  name: string;
  tag: string;
  suffix: string;
  inited: boolean = false;
  code: string | undefined;
  private importId: string | undefined;
  private importIdKey: string | undefined;
  private scopeName: string | undefined;

  static findName(tag: string, str: string = ''): string | undefined {
    if (!patternMap[tag])
      patternMap[tag] = new RegExp(`(.*${packageNameEncode(tag)}(.+?)${packageNameEncode(tag)}.*)`);
    const moduleName = (normalizeVirtualModuleId(str).match(patternMap[tag]) || [])[2];
    return moduleName ? packageNameDecode(moduleName) : undefined;
  }

  static findModule(tag: string, str: string = ''): VirtualModule | undefined {
    const moduleName = VirtualModule.findName(tag, str);
    return moduleName ? (cacheMap[tag][moduleName] as VirtualModule | undefined) : undefined;
  }

  static findById(id: string): VirtualModule | undefined {
    const normalized = normalizeVirtualModuleId(id);
    return normalized.startsWith('virtual:mf:') ? idCacheMap[normalized] : undefined;
  }

  constructor(name: string, tag: string = '__mf_v__', suffix = '', scopeName?: string) {
    this.name = name;
    this.tag = tag;
    this.suffix = suffix || getSuffix(name);
    this.scopeName = scopeName;
    if (!cacheMap[this.tag]) cacheMap[this.tag] = {};
    cacheMap[this.tag][this.name] = this;
  }

  getImportId() {
    const mfName = this.scopeName ?? getNormalizeModuleFederationOptions().internalName;
    const importIdKey = `${mfName}${this.tag}${this.name}${this.tag}`;
    if (this.importId && this.importIdKey === importIdKey) return this.importId;

    if (this.importId) delete idCacheMap[this.importId];
    this.importIdKey = importIdKey;
    this.importId = `virtual:mf:${packageNameEncode(importIdKey)}${this.suffix}`;
    idCacheMap[this.importId] = this;
    return this.importId;
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

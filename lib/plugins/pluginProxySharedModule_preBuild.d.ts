import { Plugin } from 'vite';
import { NormalizedShared } from '../utils/normalizeModuleFederationOptions';
export declare function proxySharedModule(options: {
    shared?: NormalizedShared;
    include?: string | string[];
    exclude?: string | string[];
}): Plugin[];

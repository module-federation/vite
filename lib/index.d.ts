import { Plugin } from 'vite';
import { ModuleFederationOptions } from './utils/normalizeModuleFederationOptions';
declare function federation(mfUserOptions: ModuleFederationOptions): Plugin[];
export { federation };

import VirtualModule from '../utils/VirtualModule';
export declare const LOAD_REMOTE_TAG = "__loadRemote__";
export declare function getRemoteVirtualModule(remote: string, command: string): VirtualModule;
export declare function addUsedRemote(remoteKey: string, remoteModule: string): void;
export declare function getUsedRemotesMap(): Record<string, Set<string>>;
export declare function generateRemotes(id: string, command: string): string;

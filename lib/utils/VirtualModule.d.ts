export declare const virtualPackageName = "__mf__virtual";
/**
 * Physically generate files as virtual modules under node_modules/__mf__virtual/*
 */
export default class VirtualModule {
    name: string;
    tag: string;
    suffix: string;
    inited: boolean;
    static findModule(tag: string, str?: string): VirtualModule | undefined;
    constructor(name: string, tag?: string, suffix?: string);
    getPath(): string;
    getImportId(): string;
    writeSync(code: string, force?: boolean): void;
    write(code: string): void;
}

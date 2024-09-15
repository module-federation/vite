import { Plugin } from 'vite';
interface AddEntryOptions {
    entryName: string;
    entryPath: string;
    fileName?: string;
}
declare const addEntry: ({ entryName, entryPath, fileName }: AddEntryOptions) => Plugin[];
export default addEntry;

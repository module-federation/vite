export * from './format';
// This re-export goes through a directory: './search' -> './search/index.ts'
// It tests that the plugin correctly resolves directory imports
// (not matching them as files via existsSync on the directory itself).
export * from './search';

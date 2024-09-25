export function wrapManualChunks(output: any, manualChunksCb: Function): void {
  if (!output.manualChunks) output.manualChunks = {};
  const wrapManualChunks =
    (original: any) =>
    (id: string, ...args: any[]) => {
      const customRes = manualChunksCb?.(id, ...args);
      if (customRes) return customRes;
      if (typeof original === 'function') {
        return original(id, ...args);
      }
      if (typeof original === 'object' && original) {
        return original[id];
      }
    };
  output.manualChunks = wrapManualChunks(output.manualChunks);
}

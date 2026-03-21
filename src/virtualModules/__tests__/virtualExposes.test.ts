import { describe, expect, it } from 'vitest';
import { generateExposes } from '../virtualExposes';

describe('virtualExposes', () => {
  it('generates serve-time expose wrappers with HMR accept handlers', () => {
    const code = generateExposes(
      {
        exposes: {
          './App1': { import: './src/App1' },
          './App2': { import: './src/App2.jsx' },
        },
      } as any,
      'serve'
    );

    expect(code).toContain('async function __mfLoadExpose_0() {');
    expect(code).toContain('const exposeModule = await import("./src/App1")');
    expect(code).toContain('export const __mfHmrExports = {');
    expect(code).toContain(
      'import.meta.hot.accept(["./src/App1", "./src/App2.jsx"], (modules) => {'
    );
    expect(code).toContain('if (__mfLoaded_0 && nextExpose_0) {');
    expect(code).toContain('"./App1": () => __mfLoadExpose_0()');
  });
});

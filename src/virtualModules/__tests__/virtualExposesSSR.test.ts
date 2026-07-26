import { describe, expect, it, vi } from 'vitest';
import { getDefaultMockOptions } from '../../utils/__tests__/helpers';
import { generateExposesSSR } from '../virtualExposesSSR';

function toRunnableModule(code: string) {
  const transformed = code
    .replace('export default', 'return')
    .replace(/import\((".*?")\)/g, '__dynamicImport($1)');
  return new Function('__dynamicImport', `return (async () => {${transformed}\n})();`) as (
    dynamicImport: (id: string) => Promise<unknown>
  ) => Promise<Record<string, () => Promise<unknown>>>;
}

describe('virtualExposesSSR', () => {
  it('renders a local React expose as serialized island HTML without top-level await', async () => {
    const code = generateExposesSSR(
      getDefaultMockOptions({
        exposes: { './Counter': { import: './Counter.tsx' } as any },
      }),
      new Set(['./Counter'])
    );
    const createElement = vi.fn((_component, props) => ({ props }));
    const dynamicImport = vi.fn((id: string) => {
      if (id === './Counter.tsx') {
        return Promise.resolve({ default: () => null, load: async () => ({ loaded: true }) });
      }
      if (id === 'react') return Promise.resolve({ createElement });
      if (id === 'react-dom/server') {
        return Promise.resolve({ renderToString: (element: unknown) => JSON.stringify(element) });
      }
      return Promise.reject(new Error(`unexpected import: ${id}`));
    });
    const exposes = await toRunnableModule(code)(dynamicImport);
    const module = (await exposes['./Counter']()) as any;
    const html = await module.__mf_island.renderToHtml({ count: 2 });

    expect(decodeURIComponent(html.match(/data-mf-island-state="([^"]+)"/)![1])).toBe(
      JSON.stringify({ loaded: true, count: 2 })
    );
    expect(html).toContain('{"props":{"loaded":true,"count":2}}');
    expect(code.trimStart()).toMatch(/^export default\s/);
  });

  it('does not add island code to ordinary exposes', () => {
    const code = generateExposesSSR(
      getDefaultMockOptions({ exposes: { './data': { import: './data.ts' } as any } })
    );
    expect(code).not.toContain('__mf_island');
    expect(code).not.toContain('react-dom/server');
  });
});

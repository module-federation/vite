import * as path from 'node:path';
import { build, type Rollup } from 'vite';

/** Bundle already-transformed SSR output; never rerun federation or write files. */
export async function buildSsrCjs(
  bundle: Rollup.OutputBundle,
  entryFileName: string,
  parse: (source: string) => unknown
): Promise<string> {
  const prefix = '\0mf-cjs:';
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    publicDir: false,
    plugins: [
      {
        name: 'mf:ssr-cjs-output',
        enforce: 'pre',
        resolveId(id, importer) {
          if (id === prefix + entryFileName + '.mjs') return id;
          if (importer?.startsWith(prefix) && id.startsWith('.')) {
            const name = path.posix.normalize(
              path.posix.join(path.posix.dirname(importer.slice(prefix.length, -4)), id)
            );
            if (!bundle[name])
              throw new Error(`CJS SSR entry must be fully bundled; missing output ${name}`);
            return prefix + name + '.mjs';
          }
          if (id.startsWith(prefix)) return id;
          // Remaining bare imports are intentional host-resolved externals.
          return { id, external: true };
        },
        load(id) {
          if (!id.startsWith(prefix)) return;
          const file = bundle[id.slice(prefix.length, -4)];
          const source = file?.type === 'chunk' ? file.code : file?.source;
          if (typeof source !== 'string') throw new Error(`Missing CJS SSR input ${id}`);
          try {
            assertCjsCompatible(parse(source), false);
          } catch (error) {
            throw new Error(
              `${error instanceof Error ? error.message : error} in ${id.slice(prefix.length, -4)}`
            );
          }
          return source;
        },
      },
    ],
    build: {
      write: false,
      minify: false,
      target: 'node22',
      ssr: true,
      rollupOptions: {
        input: prefix + entryFileName + '.mjs',
        output: { format: 'cjs', inlineDynamicImports: true, exports: 'named' },
      },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!('output' in output)) throw new Error('CJS SSR does not support watch output');
  const chunks = output.output.filter((file) => file.type === 'chunk');
  if (chunks.length !== 1) throw new Error('CJS SSR must produce one fully bundled entry');
  assertCjsCompatible(parse(chunks[0].code), true);
  return chunks[0].code;
}

function assertCjsCompatible(ast: unknown, finalOutput: boolean): void {
  const visit = (node: any, functionDepth = 0) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'MetaProperty' && node.meta?.name === 'import') {
      throw new Error('CJS SSR does not support import.meta');
    }
    if (
      functionDepth === 0 &&
      (node.type === 'AwaitExpression' || (node.type === 'ForOfStatement' && node.await))
    ) {
      throw new Error('CJS SSR does not support top-level await');
    }
    if (finalOutput && node.type === 'ImportExpression') {
      throw new Error('CJS SSR does not support native dynamic import; bundle the dependency');
    }
    if (node.type === 'CallExpression' && node.callee?.name === 'require') {
      const argument = node.arguments?.[0];
      const value = argument?.value;
      if (
        argument?.type !== 'Literal' ||
        typeof value !== 'string' ||
        /^(?:[./\\]|[a-zA-Z]:[\\/]|(?:https?|file|data):)/.test(value)
      ) {
        throw new Error(
          'CJS SSR requires statically named host externals and a fully bundled graph'
        );
      }
    }
    const nestedDepth =
      functionDepth +
      Number(
        ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)
      );
    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent') continue;
      if (Array.isArray(value)) value.forEach((child) => visit(child, nestedDepth));
      else if (value && typeof value === 'object') visit(value, nestedDepth);
    }
  };
  visit(ast);
}

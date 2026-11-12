import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { mkdir, writeFile, symlink } from 'node:fs/promises';
export const repo = fileURLToPath(new URL('../../', import.meta.url));
export const work = path.resolve(
  process.env.MF_CJS_MEMORY_DIR ?? path.join(repo, '.mf-cjs-memory')
);
export const count = Number(process.env.MF_CJS_MEMORY_COUNT ?? 1000);
export const size = Number(process.env.MF_CJS_MEMORY_SIZE ?? 400000);
export const requireRepo = createRequire(path.join(repo, 'package.json'));
const requireExample = createRequire(path.join(repo, 'examples/vite-vite/vite-host/package.json'));
export const reactPath = requireExample.resolve('react');
export const reactDir = path.dirname(reactPath);
export const reactDomServerPath = requireExample.resolve('react-dom/server');
export const reactDomDir = path.dirname(requireExample.resolve('react-dom/package.json'));
export const { build } = await import(pathToFileURL(requireRepo.resolve('vite')).href);
export const { federation } = await import(pathToFileURL(path.join(repo, 'lib/index.js')).href);
export const loaderUrl = pathToFileURL(path.join(repo, 'lib/utils/ssrEntryLoader.js')).href;
export async function fixture(name) {
  const root = path.join(work, 'sources', name);
  await mkdir(path.join(root, 'node_modules'), { recursive: true });
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'mf-cjs-memory',
      version: '1.0.0',
      type: 'module',
      dependencies: { react: '19.2.4', 'react-dom': '19.2.4' },
    })
  );
  for (const [name, source] of [
    ['react', reactDir],
    ['react-dom', reactDomDir],
  ]) {
    try {
      await symlink(
        source,
        path.join(root, 'node_modules', name),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  return root;
}
export async function save(name, value) {
  const file = path.join(work, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

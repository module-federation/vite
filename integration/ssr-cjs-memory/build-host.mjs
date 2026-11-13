import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fixture, build, federation, repo, save, reactDir, loaderUrl } from './common.mjs';
const root = await fixture('host');
await writeFile(
  path.join(root, 'entry.js'),
  `export {createInstance} from '@module-federation/runtime';
export {default as ssrEntryLoader,revalidate} from '@module-federation/vite/ssrEntryLoader';
export {default as React} from 'react';`
);
const outDir = path.join(root, 'dist');
const result = await build({
  configFile: false,
  root,
  logLevel: 'silent',
  plugins: [
    federation({ name: 'investigation_host_build', dts: false, hostInitInjectLocation: 'entry' }),
  ],
  build: { outDir, minify: false, target: 'node22', ssr: path.join(root, 'entry.js') },
});
const entry = result.output.find((x) => x.type === 'chunk' && x.exports.includes('createInstance'));
if (!entry) throw new Error('host entry missing');
await save('host.json', { root, entry: path.join(outDir, entry.fileName) });
console.log(path.join(outDir, entry.fileName));

import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const work = path.resolve(process.env.MF_CJS_MEMORY_DIR ?? path.join(root, '.mf-cjs-memory'));
await mkdir(path.join(work, 'results'), { recursive: true });
const nodes = process.argv.slice(2);
if (!nodes.length) nodes.push(process.execPath);
for (const [nodeIndex, node] of nodes.entries())
  for (const trigger of ['revalidate', 'maxAge'])
    for (let repeat = 0; repeat < 3; repeat++) {
      const label = `node-${nodeIndex}-${trigger}-${repeat}`;
      const log = await open(path.join(work, 'results', label + '.log'), 'w');
      console.log(JSON.stringify({ starting: label, node }));
      const code = await new Promise((resolve, reject) => {
        const child = spawn(
          node,
          ['--expose-gc', fileURLToPath(new URL('./worker.mjs', import.meta.url)), trigger],
          { stdio: ['ignore', log.fd, log.fd] }
        );
        child.on('error', reject);
        child.on('exit', resolve);
      });
      await log.close();
      if (code !== 0) throw Error(`${label} failed (${code}); see ${work}/results/${label}.log`);
      console.log(JSON.stringify({ passed: label }));
    }

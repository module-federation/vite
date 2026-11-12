import { spawn } from 'node:child_process';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const work = path.resolve(process.env.MF_CJS_MEMORY_DIR ?? path.join(root, '.mf-cjs-memory'));
await mkdir(path.join(work, 'results'), { recursive: true });
const host = JSON.parse(await readFile(path.join(work, 'host.json'), 'utf8'));
const hostFingerprint = async () =>
  createHash('sha256')
    .update(await readFile(host.entry))
    .digest('hex');
const builtHostSha256 = await hostFingerprint();
await writeFile(
  path.join(work, 'results', 'provenance.json'),
  JSON.stringify(
    {
      builtHostSha256,
      workerSha256: createHash('sha256')
        .update(await readFile(new URL('./worker.mjs', import.meta.url)))
        .digest('hex'),
      concurrentProcesses: 3,
    },
    null,
    2
  )
);
const nodes = process.argv.slice(2);
if (!nodes.length) nodes.push(process.execPath);
const statuses = [];
for (const [nodeIndex, node] of nodes.entries())
  for (const trigger of ['revalidate', 'maxAge'])
    await Promise.all(
      Array.from({ length: 3 }, async (_, repeat) => {
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
        statuses.push({ label, node, trigger, code });
        console.log(JSON.stringify({ finished: label, code }));
      })
    );
await writeFile(path.join(work, 'results', 'status.json'), JSON.stringify(statuses, null, 2));
if ((await hostFingerprint()) !== builtHostSha256) throw Error('Built host changed during the run');
if (statuses.some(({ code }) => code !== 0))
  throw Error(`Memory protocol failed; see ${work}/results`);

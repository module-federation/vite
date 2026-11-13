import { spawn } from 'node:child_process';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const work = path.resolve(process.env.MF_CJS_MEMORY_DIR ?? path.join(root, '.mf-cjs-memory'));
await mkdir(path.join(work, 'results'), { recursive: true });
const metadata = process.argv.includes('--metadata');
const nodes = process.argv.slice(2).filter((argument) => argument !== '--metadata');
if (!nodes.length) nodes.push(process.execPath);
let workerPath = fileURLToPath(new URL('./worker.mjs', import.meta.url));
let workerSource = await readFile(workerPath, 'utf8');
if (metadata) {
  // Deliberately perturb only the measured worker. Keep the original protocol
  // intact, and retain this diagnostic as a separately identified comparison.
  workerSource = "import { createHash } from 'node:crypto';\n" + workerSource;
  workerSource = workerSource
    .replace(
      "const repo = fileURLToPath(new URL('../../', import.meta.url));",
      `const repo = ${JSON.stringify(root)};`
    )
    .replace(
      'const { createInstance, ssrEntryLoader, revalidate, React } = await import(',
      `const builtHostSha256 = createHash('sha256').update(await readFile(hostInfo.entry)).digest('hex');
const { createInstance, ssrEntryLoader, revalidate, React } = await import(`
    )
    .replace(
      '  startedAt,',
      '  startedAt,\n  builtHostSha256,\n  platform: `${process.platform} ${process.arch}`,\n  viteVersion: requireRepo("vite/package.json").version,\n  reactVersion: React.version,'
    );
  workerPath = path.join(work, 'metadata-worker.mjs');
  await writeFile(workerPath, workerSource);
}
const prefix = metadata ? 'metadata-' : '';
const host = JSON.parse(await readFile(path.join(work, 'host.json'), 'utf8'));
const hostFingerprint = async () =>
  createHash('sha256')
    .update(await readFile(host.entry))
    .digest('hex');
const builtHostSha256 = await hostFingerprint();
await writeFile(
  path.join(work, 'results', prefix + 'provenance.json'),
  JSON.stringify(
    {
      builtHostSha256,
      workerSha256: createHash('sha256').update(workerSource).digest('hex'),
      metadata,
      concurrentProcesses: 3,
    },
    null,
    2
  )
);
const statuses = [];
for (const [nodeIndex, node] of nodes.entries())
  for (const trigger of metadata ? ['revalidate', 'maxAge'] : ['revalidate', 'maxAge', 'control'])
    await Promise.all(
      Array.from({ length: 3 }, async (_, repeat) => {
        const label = `${prefix}node-${nodeIndex}-${trigger}-${repeat}`;
        const log = await open(path.join(work, 'results', label + '.log'), 'w');
        console.log(JSON.stringify({ starting: label, node }));
        const code = await new Promise((resolve, reject) => {
          const child = spawn(node, ['--expose-gc', workerPath, trigger], {
            stdio: ['ignore', log.fd, log.fd],
          });
          child.on('error', reject);
          child.on('exit', resolve);
        });
        await log.close();
        statuses.push({ label, node, trigger, code });
        console.log(JSON.stringify({ finished: label, code }));
      })
    );
await writeFile(
  path.join(work, 'results', prefix + 'status.json'),
  JSON.stringify(statuses, null, 2)
);
if ((await hostFingerprint()) !== builtHostSha256) throw Error('Built host changed during the run');
if (statuses.some(({ code }) => code !== 0))
  throw Error(`Memory protocol failed; see ${work}/results`);

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { fixture, build, federation, save, repo, work, count, size } from './common.mjs';
const batch = process.argv[2] === '--batch';
if (!batch) {
  for (let start = 0; start <= count; start += 20) {
    await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(import.meta.url), '--batch', start, Math.min(start + 20, count + 1)].map(
          String
        ),
        { stdio: 'inherit' }
      );
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(Error(`Build batch ${start} failed (${code})`))
      );
    });
  }
  process.exit(0);
}
const start = Number(process.argv[3]),
  end = Number(process.argv[4]);
const records = [];
try {
  records.push(...JSON.parse(await readFile(path.join(work, 'artifacts.json'), 'utf8')));
} catch {}
const payload = `[${Array.from({ length: size }, (_, i) => i + 1).join(',')}]`;
for (const name of start === 0 ? ['b', 'a'] : ['a'])
  for (let index = name === 'a' ? start : 0; index < (name === 'a' ? end : 1); index++) {
    const marker = `${name}-release-${index}`;
    const root = await fixture(`remote-${name}-${index}`);
    await writeFile(
      path.join(root, 'widget.js'),
      `import React from 'react'; const marker=${JSON.stringify(marker)}; const payload=${payload}; export const reactIdentity=React; export const getMarker=()=>marker; export default function Widget(){return React.createElement('span',null,marker+':'+payload.length+':'+payload[globalThis.__mfProbeIndex??0]);}`
    );
    await writeFile(path.join(root, 'entry.js'), 'export {default} from "./widget.js";');
    await writeFile(
      path.join(root, 'index.html'),
      '<html><head></head><body><script type="module" src="./entry.js"></script></body></html>'
    );
    const outDir = path.join(work, 'releases', name, String(index));
    const options = () =>
      federation({
        name,
        filename: 'remoteEntry.js',
        ssrFormat: 'cjs',
        manifest: true,
        dts: false,
        hostInitInjectLocation: 'html',
        exposes: { './Widget': path.join(root, 'widget.js') },
        shared: { react: { singleton: true, requiredVersion: '19.2.4' } },
      });
    await build({
      configFile: false,
      root,
      logLevel: 'silent',
      plugins: [options()],
      build: {
        outDir,
        emptyOutDir: false,
        minify: false,
        target: 'esnext',
        rollupOptions: { input: path.join(root, 'index.html') },
      },
    });
    await build({
      configFile: false,
      root,
      logLevel: 'silent',
      plugins: [options()],
      build: {
        outDir,
        emptyOutDir: false,
        minify: false,
        target: 'node22',
        ssr: path.join(root, 'entry.js'),
      },
    });
    const manifest = JSON.parse(await readFile(path.join(outDir, 'mf-manifest.json'), 'utf8'));
    manifest.metaData.buildInfo.buildVersion = marker;
    await writeFile(path.join(outDir, 'mf-manifest.json'), JSON.stringify(manifest));
    const record = {
      name,
      index,
      marker,
      root,
      outDir,
      ssrRemoteEntry: manifest.metaData.ssrRemoteEntry,
    };
    const old = records.findIndex((x) => x.name === name && x.index === index);
    if (old < 0) records.push(record);
    else records[old] = record;
    await save('artifacts.json', records);
    console.log(JSON.stringify({ built: marker, bytes: payload.length }));
  }

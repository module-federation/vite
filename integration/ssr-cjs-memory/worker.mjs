import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import v8 from 'node:v8';
import assert from 'node:assert/strict';
import { setImmediate as turn, setTimeout as sleep } from 'node:timers/promises';

const directory = path.dirname(fileURLToPath(import.meta.url));
const repo = fileURLToPath(new URL('../../', import.meta.url));
const work = path.resolve(process.env.MF_CJS_MEMORY_DIR ?? path.join(repo, '.mf-cjs-memory'));
const { createRequire } = await import('node:module');
const requireRepo = createRequire(path.join(repo, 'package.json'));
const requireExample = createRequire(path.join(repo, 'examples/vite-vite/vite-host/package.json'));
const runtimeVersion = requireRepo('@module-federation/runtime/package.json').version;
process.chdir(repo);
const strategy = 'cjs',
  trigger = process.argv[2] ?? 'revalidate';
const count = Number(process.env.MF_CJS_MEMORY_COUNT ?? 1000),
  size = Number(process.env.MF_CJS_MEMORY_SIZE ?? 400000),
  variant = 'unique-owner';
const heapBoundMiB = 64; // Declared before any measured run.
const startedAt = new Date().toISOString();
const artifacts = JSON.parse(await readFile(path.join(work, 'artifacts.json'), 'utf8'));
assert.equal(
  artifacts.filter((x) => x.name === 'a').length,
  count + 1,
  'build all distinct releases first'
);
const hostInfo = JSON.parse(await readFile(path.join(work, 'host.json'), 'utf8'));
const { createInstance, ssrEntryLoader, revalidate, React } = await import(
  pathToFileURL(hostInfo.entry).href
);
const { renderToString } = await import(
  pathToFileURL(requireExample.resolve('react-dom/server')).href
);
const selected = { a: 0, b: 0 },
  hits = { a: [], b: [] };
const records = Object.fromEntries(artifacts.map((x) => [x.name + '/' + x.index, x]));
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const [, name, ...parts] = pathname.split('/');
    if (!Object.hasOwn(selected, name)) {
      response.writeHead(404).end();
      return;
    }
    hits[name].push(pathname);
    const file = path.resolve(records[name + '/' + selected[name]].outDir, ...parts);
    const content = await readFile(file);
    response.setHeader(
      'content-type',
      file.endsWith('.json') ? 'application/json' : 'text/javascript'
    );
    response.end(content);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const rawLoad = ssrEntryLoader({
  strategy,
  maxAgeMs: trigger === 'maxAge' ? 0 : Infinity,
  resolvedShared: { react: requireExample.resolve('react').replaceAll('\\', '/') },
});
let fallbacks = [];
const warn = console.warn;
console.warn = (...args) => {
  if (String(args[0]).includes('falling back')) {
    fallbacks.push(args.map(String).join(' '));
    warn(...args);
  }
};
const host = createInstance({
  name: 'memory_host',
  shareStrategy: 'version-first',
  remotes: ['a', 'b'].map((name) => ({
    name,
    entry: `${origin}/${name}/mf-manifest.json`,
    type: 'module',
  })),
  plugins: [rawLoad],
  shared: {
    react: {
      version: '19.2.4',
      lib: () => React,
      shareConfig: { singleton: true, requiredVersion: '19.2.4' },
    },
  },
});
assert.equal((await host.loadShare('react'))(), React);
let held;
async function render(name, keep = false) {
  const module = await host.loadRemote(`${name}/Widget`);
  assert(module, 'module must load');
  assert.equal(module.reactIdentity, React, 'exact React identity');
  assert.equal(module.getMarker(), `${name}-release-${selected[name]}`);
  const html = renderToString(React.createElement(module.default));
  assert(html.includes(`${name}-release-${selected[name]}`));
  if (keep) held = module.default;
}
async function gc6() {
  for (let i = 0; i < 6; i++) {
    await turn();
    global.gc({ type: 'major', execution: 'sync' });
    await turn();
  }
}
function stats(index) {
  const cache = globalThis.__mf_module_cache__?.share;
  const table = cache?.[Symbol.for('module-federation.shared-cache-listeners')];
  const sets = table
    ? Object.fromEntries(Object.entries(table).map(([key, value]) => [key, value.size]))
    : {};
  return {
    index,
    memory: process.memoryUsage(),
    heap: v8.getHeapStatistics(),
    spaces: v8.getHeapSpaceStatistics(),
    listeners: sets,
    initGlobals: Object.getOwnPropertyNames(globalThis).filter((key) =>
      key.startsWith('__mf_init__')
    ),
    hits: { a: hits.a.length, b: hits.b.length },
    instances: globalThis.__FEDERATION__?.__INSTANCES__?.map((x) => x.name),
  };
}
const samples = [];
await render('b');
await render('a', true);
await gc6();
samples.push(stats(0));
const bHits = hits.b.length;
for (let index = 1; index <= count; index++) {
  if (trigger !== 'control') {
    selected.a = index;
    if (trigger === 'revalidate') revalidate('a');
  }
  await render('a');
  if ([1, 10, 100, 1000].includes(index) || index === count) {
    await gc6();
    const sample = stats(index);
    samples.push(sample);
    console.log(
      JSON.stringify({
        node: process.version,
        strategy,
        trigger,
        size,
        variant,
        index,
        heapMiB: sample.memory.heapUsed / 2 ** 20,
        externalMiB: sample.memory.external / 2 ** 20,
        rssMiB: sample.memory.rss / 2 ** 20,
        listeners: sample.listeners,
        initCount: sample.initGlobals.length,
        bHits: sample.hits.b,
      })
    );
  }
}
if (trigger !== 'maxAge')
  assert.equal(hits.b.length, bHits, 'targeted A replacements must not fetch B');
assert(
  renderToString(React.createElement(held)).includes('a-release-0'),
  'held old component works'
);
let liveSubscriberProbe;
if (process.env.MF_SUBSCRIBER_PROBE === '1') {
  await gc6();
  const callbacks =
    globalThis.__mf_module_cache__.share[Symbol.for('module-federation.shared-cache-listeners')][
      'default:react'
    ];
  let updatedCalls = 0;
  const updated = {
    ...React,
    createElement(...args) {
      updatedCalls++;
      return React.createElement(...args);
    },
  };
  for (const callback of callbacks) callback(updated);
  assert(renderToString(React.createElement(held)).includes('a-release-0'));
  assert(updatedCalls > 0, 'held old component must receive subscription update after GC');
  for (const callback of callbacks) callback(React);
  assert.equal((await host.loadShare('react'))(), React, 'host singleton stays identical');
  liveSubscriberProbe = {
    callbacks: callbacks.size,
    updatedCalls,
    restoredExactReact: true,
    method: 'direct diagnostic notification through generated callbacks',
  };
  console.log(JSON.stringify({ liveSubscriberProbe }));
}
held = undefined;
await gc6();
samples.push({ ...stats(count), afterHeldRelease: true });
if (count >= 100)
  assert.equal(
    samples.at(-1).listeners['default:react'],
    2,
    'dropping held old component releases its graph subscription'
  );
assert.equal(fallbacks.length, 0, 'strategy must never silently fall back');
const bound = heapBoundMiB * 2 ** 20;
const first = samples.find((x) => x.index === 1);
const boundSamples = samples.filter((x) => [100, 1000].includes(x.index) && !x.afterHeldRelease);
const result = {
  startedAt,
  runtimeVersion,
  heapBoundMiB,
  node: process.version,
  execArgv: process.execArgv,
  strategy,
  trigger,
  size,
  variant,
  count,
  samples,
  fallbacks,
  liveSubscriberProbe,
  exactHostReact: true,
  heldOldComponent: true,
  bUnchangedFetches: hits.b.length === bHits,
  pluginVersion: requireRepo('./package.json').version,
};
await writeFile(
  path.join(work, 'results', `${process.version}-${trigger}-${process.pid}.json`),
  JSON.stringify(result, null, 2)
);
for (const sample of boundSamples)
  assert(
    sample.memory.heapUsed - first.memory.heapUsed <= bound,
    `predeclared +64MiB heap bound exceeded at ${sample.index}`
  );
server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));

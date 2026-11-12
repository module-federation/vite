// Diagnostic only. Does not import or modify the plugin or its benchmark host.
import { AsyncLocalStorage, createHook } from 'node:async_hooks';
import { createServer } from 'node:http';
import { setImmediate as turn, setTimeout as wait } from 'node:timers/promises';

if (typeof global.gc !== 'function') throw new Error('Run this diagnostic with node --expose-gc');

const context = new AsyncLocalStorage();
const timerRecords = [];
const hook = createHook({
  init(id, type, triggerId, resource) {
    const graph = context.getStore();
    if (!graph || type !== 'Timeout') return;
    timerRecords.push({
      id,
      graphLabel: graph.label,
      // Store only a WeakRef and strings/numbers: no observer-owned graph,
      // Timeout, function, Error object, or AsyncResource is retained.
      resource: new WeakRef(resource),
      duration: resource._idleTimeout,
      callback: String(resource._onTimeout).slice(0, 400),
      creationStack: new Error().stack,
    });
  },
}).enable();

const server = createServer((_request, response) => response.end('okay'));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

// Initialize fetch/undici outside any remote-like context first.
await (await fetch(url)).text();

async function transport() {
  return (await fetch(url, { signal: AbortSignal.timeout(10_000) })).text();
}

const graphs = [];
async function trial(label, isolated) {
  let graph = { label, payload: new Array(1000).fill(1) };
  const ref = new WeakRef(graph);
  await context.run(graph, () => (isolated ? context.exit(transport) : transport()));
  graph = undefined;
  graphs.push({ label, ref });
}

async function gc6() {
  for (let index = 0; index < 6; index++) {
    // Every deref in observe() occurs in an earlier job than the next GC.
    // WeakRef.deref() itself keeps the target alive until the job ends.
    await turn();
    global.gc({ type: 'major', execution: 'sync' });
    await turn();
  }
}

function observe(phase) {
  return {
    phase,
    node: process.version,
    graphs: graphs.map(({ label, ref }) => ({ label, alive: Boolean(ref.deref()) })),
    liveTimers: timerRecords
      .filter(({ resource }) => resource.deref())
      .map(({ resource, ...metadata }) => metadata),
    timeoutResourcesCreatedInsideGraphs: timerRecords.length,
  };
}

try {
  for (let index = 0; index < 3; index++) {
    await trial(`inside-${index}`, false);
    await trial(`outside-${index}`, true);
  }
  await gc6();
  console.log(JSON.stringify(observe('six ordinary major GCs'), null, 2));

  // Additional time and GCs are diagnostic only. They do not change the
  // declared memory protocol's checkpoints or turn its failures into passes.
  await wait(3400);
  await gc6();
  console.log(JSON.stringify(observe('diagnostic 3400ms wait, then six more GCs'), null, 2));
} finally {
  hook.disable();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

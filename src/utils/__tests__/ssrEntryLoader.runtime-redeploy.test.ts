import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInstance, type ModuleFederationRuntimePlugin } from '@module-federation/runtime';
import ssrEntryLoaderPlugin, { revalidate } from '../ssrEntryLoader';

interface FakeRemote {
  server: Server;
  origin: string;
  manifestUrl: string;
  hits: string[];
  setVersion: (version: string) => void;
}

// A remote whose manifest and SSR entry change together on "redeploy".
async function startRemote(name: string, initialVersion = 'v1'): Promise<FakeRemote> {
  let version = initialVersion;
  const hits: string[] = [];
  const manifest = () => ({
    id: name,
    name,
    metaData: {
      name,
      type: 'app',
      buildInfo: { buildVersion: version, buildName: name },
      remoteEntry: { name: 'remoteEntry.js', path: '', type: 'module' },
      ssrRemoteEntry: { name: 'remoteEntry.ssr.js', path: '', type: 'module' },
      types: { path: '', name: '', zip: '', api: '' },
      globalName: name,
      publicPath: 'auto',
    },
    shared: [],
    remotes: [],
    exposes: [
      {
        id: `${name}:Widget`,
        name: 'Widget',
        path: './Widget',
        assets: { js: { sync: [], async: [] }, css: { sync: [], async: [] } },
      },
    ],
  });
  const server = createServer((request, response) => {
    hits.push(request.url ?? '');
    if (request.url?.startsWith('/mf-manifest.json')) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(manifest()));
      return;
    }
    if (request.url?.startsWith('/remoteEntry.ssr.js')) {
      response.setHeader('content-type', 'application/javascript');
      response.end(
        `export const init = async () => {}; export const get = async () => () => ({ default: ${JSON.stringify(version)} });`
      );
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no TCP address');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    server,
    origin,
    manifestUrl: `${origin}/mf-manifest.json`,
    hits,
    setVersion(next) {
      version = next;
    },
  };
}

const servers: Server[] = [];
const instances: object[] = [];

async function remote(name: string) {
  const r = await startRemote(name);
  servers.push(r.server);
  return r;
}

function host(remotes: Array<{ name: string; entry: string; type?: string }>, maxAgeMs?: number) {
  const loader = ssrEntryLoaderPlugin({ maxAgeMs }) as unknown as ModuleFederationRuntimePlugin;
  const loadEntry = vi.spyOn(loader, 'loadEntry');
  const mf = createInstance({
    name: `redeploy-host-${Math.random().toString(36).slice(2)}`,
    remotes,
    plugins: [loader],
  });
  instances.push(mf);
  return { mf, loadEntry };
}

async function load(mf: ReturnType<typeof createInstance>, id: string): Promise<string> {
  return ((await mf.loadRemote(id)) as { default: string }).default;
}

function snapshotVersion(mf: ReturnType<typeof createInstance>, manifestUrl: string) {
  return (
    mf.snapshotHandler.manifestCache.get(manifestUrl) as
      | { metaData?: { buildInfo?: { buildVersion?: string } } }
      | undefined
  )?.metaData?.buildInfo?.buildVersion;
}

afterEach(async () => {
  vi.restoreAllMocks();
  const global = globalThis as typeof globalThis & {
    __FEDERATION__?: { __INSTANCES__?: unknown[] };
  };
  if (global.__FEDERATION__?.__INSTANCES__) {
    global.__FEDERATION__.__INSTANCES__ = global.__FEDERATION__.__INSTANCES__.filter(
      (instance) => !instances.includes(instance as object)
    );
  }
  instances.length = 0;
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

describe('ssrEntryLoaderPlugin — redeployed remotes in a running runtime host', () => {
  it('picks up a redeployed manifest remote once maxAgeMs elapsed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await remote('redeploy_a');
    const { mf } = host([{ name: 'redeploy_a', entry: r.manifestUrl }], 0);

    expect(await load(mf, 'redeploy_a/Widget')).toBe('v1');
    r.setVersion('v2');
    expect(await load(mf, 'redeploy_a/Widget')).toBe('v2');
    expect(snapshotVersion(mf, r.manifestUrl)).toBe('v2');
    expect(await load(mf, 'redeploy_a/Widget')).toBe('v2');
  });

  it('does not re-check the manifest before maxAgeMs elapsed', async () => {
    const r = await remote('redeploy_b');
    const { mf, loadEntry } = host([{ name: 'redeploy_b', entry: r.manifestUrl }], 60_000);

    expect(await load(mf, 'redeploy_b/Widget')).toBe('v1');
    r.setVersion('v2');
    r.hits.length = 0;
    expect(await load(mf, 'redeploy_b/Widget')).toBe('v1');
    expect(r.hits).toEqual([]);
    expect(loadEntry).toHaveBeenCalledTimes(1);
  });

  it('keeps serving the loaded version when the manifest is unchanged', async () => {
    const r = await remote('redeploy_c');
    const { mf, loadEntry } = host([{ name: 'redeploy_c', entry: r.manifestUrl }], 0);

    expect(await load(mf, 'redeploy_c/Widget')).toBe('v1');
    expect(await load(mf, 'redeploy_c/Widget')).toBe('v1');
    expect(loadEntry).toHaveBeenCalledTimes(1);
  });

  it('revalidate(manifestUrl) resets only that remote, including the runtime snapshot', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = await remote('redeploy_d');
    const b = await remote('redeploy_e');
    const { mf, loadEntry } = host([
      { name: 'redeploy_d', entry: a.manifestUrl },
      { name: 'redeploy_e', entry: b.manifestUrl },
    ]);

    expect(await load(mf, 'redeploy_d/Widget')).toBe('v1');
    expect(await load(mf, 'redeploy_e/Widget')).toBe('v1');
    a.setVersion('v2');
    b.setVersion('v2');
    revalidate(a.manifestUrl);

    expect(await load(mf, 'redeploy_d/Widget')).toBe('v2');
    expect(snapshotVersion(mf, a.manifestUrl)).toBe('v2');
    expect(await load(mf, 'redeploy_e/Widget')).toBe('v1');
    expect(snapshotVersion(mf, b.manifestUrl)).toBe('v1');
    expect(loadEntry).toHaveBeenCalledTimes(3);
  });

  it('revalidate(remoteName) and a forced re-register both load the new SSR entry', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await remote('redeploy_f');
    const entry = { name: 'redeploy_f', entry: r.manifestUrl };
    const { mf } = host([entry]);

    expect(await load(mf, 'redeploy_f/Widget')).toBe('v1');
    r.setVersion('v2');
    revalidate('redeploy_f');
    expect(await load(mf, 'redeploy_f/Widget')).toBe('v2');

    r.setVersion('v3');
    mf.registerRemotes([entry], { force: true });
    expect(await load(mf, 'redeploy_f/Widget')).toBe('v3');
    expect(snapshotVersion(mf, r.manifestUrl)).toBe('v3');
  });

  it('picks up a redeployed remoteEntry.js remote once maxAgeMs elapsed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await remote('redeploy_g');
    const { mf } = host(
      [{ name: 'redeploy_g', entry: `${r.origin}/remoteEntry.js`, type: 'module' }],
      0
    );

    expect(await load(mf, 'redeploy_g/Widget')).toBe('v1');
    r.setVersion('v2');
    expect(await load(mf, 'redeploy_g/Widget')).toBe('v2');
  });
});

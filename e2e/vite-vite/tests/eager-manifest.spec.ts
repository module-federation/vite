import { expect, test } from '@playwright/test';

test('classifies eager and deferred share wrappers in the built manifest', async ({ request }) => {
  const response = await request.get('/mf-manifest.json');
  expect(response.ok()).toBe(true);

  const manifest = await response.json();
  const exposed = manifest.exposes.find(
    ({ name }: { name: string }) => name === 'EagerManifestFixture'
  );
  expect(exposed).toBeDefined();

  const { sync, async } = exposed.assets.js;
  const eagerAsset = sync.find((asset: string) => asset.includes('loadShare-eager'));
  expect(eagerAsset).toBeDefined();

  // The consume-only vue wrapper has no fallback to isolate, so it is not a chunk of its
  // own: it lives inside the expose chunk, which stays synchronous, and never in the
  // eager group.
  expect(
    [...sync, ...async].some((asset: string) => asset.includes('__loadShare__vue__loadShare__'))
  ).toBe(false);
  const fixtureAsset = sync.find((asset: string) => asset.includes('EagerManifestFixture'));
  expect(fixtureAsset).toBeDefined();
  expect(async.some((asset: string) => asset.includes('EagerManifestFixture'))).toBe(false);

  const fixtureCode = await (await request.get(`/${fixtureAsset}`)).text();
  expect(fixtureCode).toContain('default:vue@');
  const eagerCode = await (await request.get(`/${eagerAsset}`)).text();
  expect(eagerCode).not.toContain('default:vue@');
});

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
  expect(sync.some((asset: string) => asset.includes('loadShare-eager'))).toBe(true);
  expect(async.some((asset: string) => asset.includes('__loadShare__vue__loadShare__'))).toBe(true);
  expect(sync.some((asset: string) => asset.includes('__loadShare__vue__loadShare__'))).toBe(false);
});

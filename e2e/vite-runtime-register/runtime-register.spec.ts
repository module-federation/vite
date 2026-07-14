import { expect, test } from '@playwright/test';

test('uses a runtime host get-only React singleton', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));

  await page.goto('/');
  await page.getByRole('button', { name: 'registerRemotes()' }).click();
  await page.getByRole('button', { name: 'loadRemote() component' }).click();

  await expect(page.getByRole('heading', { name: 'Remote component mounted' })).toBeVisible();

  const counter = page.getByTestId('runtime-remote-counter');
  await expect(counter).toHaveText('count: 0');
  await counter.click();
  await expect(counter).toHaveText('count: 1');
  const shareHooks = await page.evaluate(() => {
    const runtimeGlobal = globalThis as typeof globalThis & {
      __runtimeRegisterShareHooks?: string[];
    };
    return runtimeGlobal.__runtimeRegisterShareHooks ?? [];
  });
  expect(shareHooks).toEqual(
    expect.arrayContaining(['beforeLoadShare', 'resolveShare', 'afterLoadShare'])
  );
  expect(pageErrors).toEqual([]);
});

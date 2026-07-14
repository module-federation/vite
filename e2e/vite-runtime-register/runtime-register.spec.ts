import { expect, test } from '@playwright/test';

test('uses a runtime host get-only React singleton', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));

  await page.goto('/');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              __runtimeRegisterReactGetCalls?: number;
            }
          ).__runtimeRegisterReactGetCalls ?? -1
      )
    )
    .toBe(0);
  await page.getByRole('button', { name: 'registerRemotes()' }).click();
  await page.getByRole('button', { name: 'loadRemote() component' }).click();

  await expect(page.getByRole('heading', { name: 'Remote component mounted' })).toBeVisible();
  await expect(page.getByTestId('runtime-react-identity')).toHaveText('host React identity');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              __runtimeRegisterReactGetCalls?: number;
            }
          ).__runtimeRegisterReactGetCalls ?? 0
      )
    )
    .toBeGreaterThan(0);

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

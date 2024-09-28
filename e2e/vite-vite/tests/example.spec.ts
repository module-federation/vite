import { expect, test } from '@playwright/test';

test('verify basic test', async ({ page, baseURL }) => {
  await page.goto(baseURL!);
  const heading = page.getByRole('heading', { name: 'Vite Host', exact: true });
  await expect(heading).toBeVisible();
});

import { expect, test } from '@playwright/test';

test('example.com basic test', async ({ page, baseURL }) => {
  await page.goto(baseURL!);

  // Get the heading by role with exact name 'Rust Host'
  const heading = page.getByRole('heading', { name: 'Rust Host', exact: true });

  // Expect the heading to be visible
  await expect(heading).toBeVisible();
});

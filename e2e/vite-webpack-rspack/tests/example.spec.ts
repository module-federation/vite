import { expect, test } from '@playwright/test';

test('example.com basic test', async ({ page }) => {
  // Go to example.com
  await page.goto('https://example.com');

  // Check the title of the page
  await expect(page).toHaveTitle('Example Domain');

  // Check if the heading exists on the page
  const heading = page.locator('h1');
  await expect(heading).toHaveText('Example Domain');
});

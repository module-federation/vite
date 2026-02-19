import { expect, test } from '@playwright/test';

test.describe('vite-vite remote preview', () => {
  test('renders the remote app', async ({ page }) => {
    await page.goto('/');
    const heading = page.getByRole('heading', { name: 'Vite + React', exact: true });
    await expect(heading).toBeVisible();
  });
});

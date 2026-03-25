import { expect, test } from '@playwright/test';

test.describe('vite-vite remote preview', () => {
  test('renders the remote app', async ({ page }) => {
    await page.goto('/');
    const heading = page.getByRole('heading', { name: 'Vite + React', exact: true });
    await expect(heading).toBeVisible();
  });

  test('renders shared-lib component', async ({ page }) => {
    await page.goto('/');
    const counter = page.getByTestId('shared-counter-[shared-lib] Remote');
    await expect(counter).toBeVisible();
    await expect(counter.locator('strong')).toHaveText('[shared-lib] Remote');
    const button = counter.getByRole('button');
    await expect(button).toHaveText('count: 0');
    await button.click();
    await button.click();
    await button.click();
    await expect(button).toHaveText('count: 3');
  });
});

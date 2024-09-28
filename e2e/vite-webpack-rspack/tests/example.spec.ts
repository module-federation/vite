import { expect, test } from '@playwright/test';

test.describe('Vite Host Tests', () => {
  test('test header - vite host', async ({ page, baseURL }) => {
    await page.goto(baseURL!);

    const womenButton = page.getByRole('button', { name: 'Women', exact: true });
    const manButton = page.getByRole('button', { name: 'Man', exact: true });
    const companyButton = page.getByRole('button', { name: 'Company', exact: true });
    const storesButton = page.getByRole('button', { name: 'Stores', exact: true });

    await Promise.all([
      expect(womenButton).toBeVisible(),
      expect(manButton).toBeVisible(),
      expect(companyButton).toBeVisible(),
      expect(storesButton).toBeVisible(),
    ]);
  });

  test('test footer - vite host', async ({ page, baseURL }) => {
    // Go to example.com
    await page.goto(baseURL!);

    const productsHeading = page.getByRole('heading', { level: 3, name: 'Products', exact: true });
    const companyHeading = page.getByRole('heading', { level: 3, name: 'Company', exact: true });
    const customerServiceHeading = page.getByRole('heading', {
      level: 3,
      name: 'Customer Service',
      exact: true,
    });

    await Promise.all([
      expect(productsHeading).toBeVisible(),
      expect(companyHeading).toBeVisible(),
      expect(customerServiceHeading).toBeVisible(),
    ]);
  });
});

test.fixme('test vite remote', async ({ page, baseURL }) => {
  await page.goto(baseURL!);
});

test.fixme('test rspack remote', async ({ page, baseURL }) => {
  await page.goto(baseURL!);
});

test.fixme('test webpack remote', async ({ page, baseURL }) => {
  await page.goto(baseURL!);
});

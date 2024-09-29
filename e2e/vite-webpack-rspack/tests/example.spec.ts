import { expect, test } from '@playwright/test';

test.describe('Vite Host Tests', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    await page.goto(baseURL!);
  });

  test('test header - vite host', async ({ page }) => {
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

  test('test footer - vite host', async ({ page }) => {
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

test.describe('Vite remote', () => {});

test.describe('Rspack remote', () => {
  test('has title', async ({ page, baseURL }) => {
    await page.goto(baseURL!);
    const recentReviews = page.getByRole('heading', {
      level: 2,
      name: 'Customers also purchased',
      exact: true,
    });
    await expect(recentReviews).toBeVisible();
  });
});

test.describe('Webpack remote', () => {
  test('has title', async ({ page, baseURL }) => {
    await page.goto(baseURL!);
    const furtherRecommendations = page.getByRole('heading', {
      level: 2,
      name: 'Customers also purchased',
      exact: true,
    });
    await expect(furtherRecommendations).toBeVisible();
  });

  test('navigates to product page onclick', async () => {
    // !TODO: to test proper navigation in the host!
  });
});

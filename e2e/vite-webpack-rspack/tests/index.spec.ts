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

test.describe('Vite remote', () => {
  test('has title', async ({ page, baseURL }) => {
    await page.goto(baseURL!);
    const productHeader = page.getByRole('heading', {
      level: 1,
      name: 'Basic Tee',
      exact: true,
    });
    await expect(productHeader).toBeVisible();
  });
});

test.describe('Rspack remote', () => {
  test('has title', async ({ page, baseURL }) => {
    await page.goto(baseURL!);
    const recentReviews = page.getByRole('heading', {
      level: 2,
      name: 'Recent reviews',
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
});

test.describe('Dynamic remote', () => {
  test('shows dynamic banner on toggle', async ({ page, baseURL }) => {
    await page.goto(baseURL!);
    const showAdToggle = page.getByRole('checkbox', { name: 'Show Dynamic Ad', exact: true });

    const signUpBanner = page.getByRole('heading', { level: 2, name: 'Sign up now!', exact: true });
    const specialPromoBanner = page.getByRole('heading', {
      level: 2,
      name: 'Up to 50% off!',
    });

    await showAdToggle.check({ force: true });

    // Special Promo banner should be visible after toggling
    await expect(specialPromoBanner).toBeVisible();
    await expect(signUpBanner).not.toBeVisible();

    // Toggle again, no banner should be visible
    await showAdToggle.uncheck({ force: true });

    await expect(signUpBanner).not.toBeVisible();
    await expect(specialPromoBanner).not.toBeVisible();

    // Toggle again, SignUpBanner should be visible
    await showAdToggle.check({ force: true });

    await expect(signUpBanner).toBeVisible();
    await expect(specialPromoBanner).not.toBeVisible();
  });
});

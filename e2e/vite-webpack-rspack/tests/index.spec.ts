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
    const testsButton = page.getByRole('button', { name: 'Tests', exact: true });

    await Promise.all([
      expect(womenButton).toBeVisible(),
      expect(manButton).toBeVisible(),
      expect(companyButton).toBeVisible(),
      expect(storesButton).toBeVisible(),
      expect(testsButton).toBeVisible(),
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
  test('has sizes', async ({ page, baseURL }) => {
    await page.goto(baseURL!);
    const xsRadio = page.getByRole('radio', { name: 'XS', exact: true });
    const sRadio = page.getByRole('radio', { name: 'S', exact: true });
    const mRadio = page.getByRole('radio', { name: 'M', exact: true });
    const lRadio = page.getByRole('radio', { name: 'L', exact: true });
    const xlRadio = page.getByRole('radio', { name: 'XL', exact: true });
    const xxlRadio = page.getByRole('radio', { name: 'XXL', exact: true });

    await Promise.all([
      expect(xsRadio).toBeVisible(),
      expect(sRadio).toBeVisible(),
      expect(mRadio).toBeVisible(),
      expect(lRadio).toBeVisible(),
      expect(xlRadio).toBeVisible(),
      expect(xxlRadio).toBeVisible(),
      expect(xxlRadio).toBeVisible(),
    ]);

    expect(await xxlRadio.isChecked()).toBe(false);
    expect(await mRadio.isChecked()).toBe(true);

    await xxlRadio.check();

    expect(await xxlRadio.isChecked()).toBe(true);
    expect(await mRadio.isChecked()).toBe(false);
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

test.describe('Tests remote', () => {
  test('tests screen is available', async ({ page, baseURL }) => {
    await page.goto(baseURL!);
    const testsButton = page.getByRole('button', { name: 'Tests', exact: true });
    await expect(testsButton).toBeVisible();

    testsButton.click();

    const testsHeading = page.getByRole('heading', { level: 1, name: 'Tests Screen', exact: true });
    await expect(testsHeading).toBeVisible();

    const chartJsElement = page.getByTestId('e2e-chart-js');
    const dropzoneText = page.getByText("Drag 'n' drop some files here");
    const easyCropElement = page.getByTestId('e2e-easy-crop');

    await Promise.all([
      expect(chartJsElement).toBeVisible(),
      expect(dropzoneText).toBeVisible(),
      expect(easyCropElement).toBeVisible(),
    ]);
  });
});

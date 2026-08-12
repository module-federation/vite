import { expect, test } from '@playwright/test';

// Guards the SSR-consumption architecture: a client-only remote publishes
// remoteEntry.ssr.js with its client assets, and an SSR host's Node server
// fetches it over HTTP to render federated components before hydration.
// Regressed in #1024 (no SSR entry emitted → hosts crashed with
// ERR_UNSUPPORTED_ESM_URL_SCHEME and served no federated content).

test('client-only remote publishes its SSR entry as JavaScript', async ({ request }) => {
  const response = await request.get('http://localhost:5177/remoteEntry.ssr.js');
  expect(response.status()).toBe(200);
  // Guard against an SPA index.html fallback masquerading as a 200.
  expect(response.headers()['content-type']).toContain('javascript');
});

test('host serves the federated widget as server-rendered HTML', async ({ request }) => {
  const response = await request.get('/');
  expect(response.status()).toBe(200);
  const html = await response.text();
  expect(html).toContain('SSR remote widget');
  expect(html).toContain('Remote count:');
});

test('server-rendered widget hydrates and responds to input', async ({ page }) => {
  await page.goto('/');
  const button = page.getByRole('button', { name: /Remote count: 0/ });
  await expect(button).toBeVisible();
  // The server-rendered button is inert until hydration attaches handlers.
  await page.locator('body[data-hydrated="true"]').waitFor();
  await button.click();
  await expect(page.getByRole('button', { name: /Remote count: 1/ })).toBeVisible();
});

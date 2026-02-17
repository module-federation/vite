import { expect, test } from '@playwright/test';

/**
 * These tests run against the host preview (port 5175) which loads remote
 * modules from the remote preview (port 5176). Both must be running.
 *
 * This exercises the full Module Federation pipeline in build mode:
 * shared deps, default imports, named imports, CJS interop, etc.
 */
test.describe('vite-vite host preview', () => {
  test('renders host app with React shared dep', async ({ page }) => {
    await page.goto('/');
    const heading = page.getByRole('heading', { name: 'MF HOST Demo', exact: true });
    await expect(heading).toBeVisible();
  });

  test('renders Emotion styled component from remote', async ({ page }) => {
    await page.goto('/');
    // EmotionDemo uses `import styled from '@emotion/styled'` (default import).
    // This breaks if the ESM shims plugin doesn't handle default export interop.
    const emotionText = page.getByText('Heading with a green background and yellow text.');
    await expect(emotionText).toBeVisible();
  });

  test('renders Styled Components demo from remote', async ({ page }) => {
    await page.goto('/');
    const heading = page.getByRole('heading', {
      name: 'Styled Components Demo',
      exact: true,
    });
    await expect(heading).toBeVisible();
  });
});

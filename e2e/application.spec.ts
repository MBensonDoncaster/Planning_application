import { test, expect } from '@playwright/test';

test('approved synthetic admin navigates the shell and database-backed user administration', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/call-for-sites$/);
  await expect(page.getByRole('heading', { name: 'Browse submissions' })).toBeVisible();
  const navigation = page.getByRole('navigation', { name: 'Call for Sites navigation' });
  await navigation.getByRole('link', { name: 'Upload files' }).click();
  await expect(page.getByRole('heading', { name: 'Upload files' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Upload files' })).toBeVisible();
  await page.getByRole('link', { name: /Administration/ }).click();
  await page.getByRole('link', { name: 'Users', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'User administration' })).toBeVisible();
  await expect(page.getByText('synthetic-pending@example.test', { exact: true })).toBeVisible();
});

test('database-backed APIs expose public configuration and safe JSON errors', async ({ request }) => {
  const response = await request.get('/api/v1/app/config');
  expect(response.ok()).toBe(true);
  expect((await response.json()).enabledModules.map((module: { id: string }) => module.id)).toEqual(['call-for-sites']);
  const missing = await request.get('/api/v1/missing', { headers: { accept: 'text/html' } });
  expect(missing.status()).toBe(404);
  expect((await missing.json()).error.requestId).toBe(missing.headers()['x-request-id']);
});

for (const [status, title] of [['PENDING', 'Awaiting administrator approval'], ['REJECTED', 'Access request declined'], ['DISABLED', 'Your account is disabled']]) {
  test(`${status} administrator sees the blocked account screen on a deep link`, async ({ page }) => {
    // Mock the session response only; backend permission states have separate HTTP/database tests.
    await page.route('**/api/v1/auth/me', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), role: 'ADMIN', status } });
    });
    await page.goto('/call-for-sites/delete');
    await expect(page).toHaveURL(/\/access$/);
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Call for Sites', exact: true })).toHaveCount(0);
  });
}

test('USER cannot reach administrator deletion through a direct URL', async ({ page }) => {
  await page.route('**/api/v1/auth/me', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), role: 'USER' } });
  });
  await page.goto('/call-for-sites/delete');
  await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Administration/ })).toHaveCount(0);
});

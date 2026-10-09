import { test, expect } from '@playwright/test';
import { ROLE_CAPABILITIES } from '@planning/contracts';

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
  const session = await request.get('/api/v1/auth/me');
  expect(session.ok()).toBe(true);
  expect(await session.json()).toMatchObject({ user: { role: 'ADMIN', status: 'APPROVED' }, capabilities: ROLE_CAPABILITIES.ADMIN });
  const response = await request.get('/api/v1/app/config');
  expect(response.ok()).toBe(true);
  expect((await response.json()).enabledModules.map((module: { id: string }) => module.id)).toEqual(['call-for-sites']);
  const missing = await request.get('/api/v1/missing', { headers: { accept: 'text/html' } });
  expect(missing.status()).toBe(404);
  expect((await missing.json()).error.requestId).toBe(missing.headers()['x-request-id']);
});

test('admin confirms access removal and reopens a rejected or disabled account for separate approval', async ({ page, request }) => {
  await page.goto('/admin/users');
  const email = 'synthetic-pending@example.test';
  const row = page.getByRole('row').filter({ hasText: email });
  await expect(row).toContainText('PENDING');
  const listing = await request.get(`/api/v1/admin/users?text=${encodeURIComponent(email)}`);
  const target = (await listing.json()).users.find((user: { email: string }) => user.email === email);
  expect(target).toBeTruthy();
  try {
    for (const [button, status] of [['Approve', 'APPROVED'], ['Disable account', 'DISABLED'], ['Return to pending approval', 'PENDING'], ['Reject', 'REJECTED'], ['Return to pending approval', 'PENDING']]) {
      await row.getByRole('button', { name: /Manage/ }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: button, exact: true }).click();
      await expect(dialog.getByRole('alert')).toContainText('Confirm');
      await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(row).toContainText(status);
      if (status === 'PENDING') {
        const refreshed = await request.get(`/api/v1/admin/users?text=${encodeURIComponent(email)}`);
        expect((await refreshed.json()).users[0]).toMatchObject({ role: 'USER', status: 'PENDING', approvedAt: null, approvedByUserId: null });
      }
    }
  } finally {
    // Restore this shared synthetic fixture even when a browser assertion fails.
    const refreshed = await request.get(`/api/v1/admin/users?text=${encodeURIComponent(email)}`);
    const current = (await refreshed.json()).users[0];
    if (current.status === 'APPROVED') await request.post(`/api/v1/admin/users/${target.id}/disable`);
    if (current.status !== 'PENDING') await request.post(`/api/v1/admin/users/${target.id}/enable`);
  }
});

for (const [status, title] of [['PENDING', 'Awaiting administrator approval'], ['REJECTED', 'Access request declined'], ['DISABLED', 'Your account is disabled']]) {
  test(`${status} administrator sees the blocked account screen on a deep link`, async ({ page }) => {
    // Mock the session response only; backend permission states have separate HTTP/database tests.
    await page.route('**/api/v1/auth/me', async route => {
      const response = await route.fetch();
      const session = await response.json();
      await route.fulfill({ response, json: { ...session, user: { ...session.user, role: 'ADMIN', status }, capabilities: [] } });
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
    const session = await response.json();
    await route.fulfill({ response, json: { ...session, user: { ...session.user, role: 'USER' }, capabilities: ROLE_CAPABILITIES.USER } });
  });
  await page.goto('/call-for-sites/delete');
  await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Administration/ })).toHaveCount(0);
});

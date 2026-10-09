import { test, expect } from '@playwright/test';

// Browser traces contain response bodies and DOM snapshots, including one-time keys.
// Keep synthetic secrets out of saved diagnostics as well as application storage.
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('administrator creates, clears, rotates and revokes integration keys through the real API', async ({ page, request }) => {
  const name = `Synthetic browser RPA ${crypto.randomUUID()}`;
  await page.goto('/admin/integrations');
  await expect(page.getByRole('heading', { name: 'Integrations', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create integration', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Integration name').fill(name);
  const createdResponse = page.waitForResponse(response => response.url().endsWith('/api/v1/admin/integrations') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Create integration', exact: true }).click();
  const created = await createdResponse;
  expect(created.status()).toBe(201);
  const integrationId: string = (await created.json()).id;
  try {
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: `Generate key for ${name}`, exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('Key label').fill('Synthetic initial key');
    await dialog.getByRole('button', { name: 'Generate key', exact: true }).click();
    const field = dialog.getByLabel('One-time API key');
    await expect(field).toBeVisible();
    const secret = await field.inputValue();
    // Compare booleans so failure output cannot print the plaintext.
    expect(secret.startsWith('pln_') && secret.includes('.')).toBe(true);
    expect(await page.evaluate(value => !JSON.stringify(localStorage).includes(value) && !JSON.stringify(sessionStorage).includes(value) && !location.href.includes(value), secret)).toBe(true);
    const safeListing = await request.get('/api/v1/admin/integrations?page=1');
    expect((await safeListing.text()).includes(secret)).toBe(false);
    await dialog.getByRole('button', { name: 'Close and clear key' }).click();
    await page.reload();
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    expect(await page.locator('body').textContent().then(value => value?.includes(secret))).toBe(false);
    const table = page.getByRole('table', { name: `API keys for ${name}`, exact: true });
    await expect(table.getByRole('columnheader', { name: 'Last authenticated use' })).toBeVisible();
    await page.getByRole('button', { name: 'Rotate Synthetic initial key', exact: true }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Overlap hours')).toHaveValue('0');
    await dialog.getByRole('button', { name: 'Confirm rotation' }).click();
    await expect(dialog.getByLabel('One-time API key')).toBeVisible();
    const replacementSecret = await dialog.getByLabel('One-time API key').inputValue();
    expect(replacementSecret !== secret).toBe(true);
    await expect(dialog.getByText(/Previous key effective expiry:/)).toBeVisible();
    await expect(dialog.getByText(/New key effective expiry:/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Close and clear key' }).click();
    let listing = await request.get('/api/v1/admin/integrations?page=1');
    let current = (await listing.json()).integrations.find((item: { id: string }) => item.id === integrationId);
    expect(current.keys.map((key: { status: string }) => key.status).sort()).toEqual(['ACTIVE', 'REVOKED']);
    const activeRow = table.getByRole('row').filter({ hasText: 'ACTIVE' });
    await activeRow.getByRole('button', { name: /^Rotate/ }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('Overlap hours').fill('24');
    await dialog.getByRole('button', { name: 'Confirm rotation' }).click();
    await expect(dialog.getByLabel('One-time API key')).toBeVisible();
    await dialog.getByRole('button', { name: 'Close and clear key' }).click();
    const scheduledRow = table.getByRole('row').filter({ hasText: 'SCHEDULED REVOCATION' });
    await expect(scheduledRow.getByRole('button', { name: /^Rotate/ })).toBeDisabled();
    await scheduledRow.getByRole('button', { name: /^Revoke/ }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(table.getByText('SCHEDULED REVOCATION', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: `Disable ${name}`, exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('button', { name: `Generate key for ${name}`, exact: true })).toBeEnabled();
    await page.getByRole('button', { name: `Disable ${name}`, exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByRole('button', { name: `Generate key for ${name}`, exact: true })).toBeDisabled();
    await page.getByRole('button', { name: `Re-enable ${name}`, exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Expired and revoked keys will remain unusable');
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByRole('button', { name: `Generate key for ${name}`, exact: true })).toBeEnabled();
    listing = await request.get('/api/v1/admin/integrations?page=1');
    current = (await listing.json()).integrations.find((item: { id: string }) => item.id === integrationId);
    expect(current.keys.map((key: { status: string }) => key.status).sort()).toEqual(['ACTIVE', 'REVOKED', 'REVOKED']);
  } finally {
    if (integrationId) await request.patch(`/api/v1/admin/integrations/${integrationId}`, { data: { enabled: false } });
  }
});

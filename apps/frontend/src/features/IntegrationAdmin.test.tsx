import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiKeySummary, IntegrationListing, IntegrationWithKeys } from '@planning/contracts';
import { IntegrationAdmin } from './IntegrationAdmin';
import { ApiError, request } from '../api';

vi.mock('../api', async importOriginal => ({ ...await importOriginal<typeof import('../api')>(), request: vi.fn() }));
const call = vi.mocked(request);
const key: ApiKeySummary = { id: 'key-id', integrationId: 'integration-id', label: 'Robot key', publicPrefix: 'pln_key-id', capabilities: ['call-for-sites.submit'], effectiveCapabilities: ['call-for-sites.submit'], status: 'ACTIVE', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:00:00.000Z', effectiveExpiresAt: '2030-01-01T00:00:00.000Z', revokedAt: null, lastUsedAt: null, createdByUserId: 'admin-id', revokedByUserId: null };
const integration: IntegrationWithKeys = { id: 'integration-id', name: 'Robot upload', description: 'Synthetic RPA', enabled: true, createdAt: '', updatedAt: '', createdByUserId: 'admin-id', keys: [key] };
const secret = 'pln_new-key.synthetic-one-time-secret';
const limits = { apiKeyDefaultExpiryDays: 90, apiKeyMaxExpiryDays: 365 };
beforeEach(() => { call.mockReset(); localStorage.clear(); sessionStorage.clear(); });
async function show(value = integration, total = 1) {
  const listing: IntegrationListing = { integrations: [value], page: 1, pageSize: 50, total };
  call.mockImplementation(async (_path, options) => options?.method ? { key, secret, previousKeyRevokesAt: '2026-10-09T10:00:00.000Z' } as never : listing as never);
  const refreshAccess = vi.fn(async () => {});
  const result = render(<IntegrationAdmin limits={limits} timezone="Europe/London" refreshAccess={refreshAccess} />);
  await screen.findByRole('heading', { name: 'Robot upload' });
  return { ...result, refreshAccess };
}
function dialog() { return within(screen.getByRole('dialog')); }
function writes() { return call.mock.calls.filter(([, options]) => options?.method); }
async function generate() {
  fireEvent.click(screen.getByRole('button', { name: 'Generate key for Robot upload' }));
  fireEvent.change(dialog().getByRole('textbox', { name: 'Key label' }), { target: { value: 'Replacement' } });
  fireEvent.click(dialog().getByRole('button', { name: 'Generate key' }));
  await screen.findByRole('textbox', { name: 'One-time API key' });
}

describe('integration administration', () => {
  it('shows safe metadata, effective scope, expiry and authenticated-use label with fixed pages of 50', async () => {
    await show(integration, 51);
    expect(screen.getByText('Call for Sites Submit')).toBeVisible();
    expect(screen.getByText('Last authenticated use')).toBeVisible();
    expect(screen.getByText('Never')).toBeVisible();
    expect(screen.getByText('1–50 of 51')).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'One-time API key' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Go to next page' }));
    await waitFor(() => expect(call.mock.calls.at(-1)?.[0]).toBe('/admin/integrations?page=2'));
  });
  it('creates an integration with trimmed inputs', async () => {
    await show();
    fireEvent.click(screen.getByRole('button', { name: 'Create integration' }));
    fireEvent.change(dialog().getByRole('textbox', { name: 'Integration name' }), { target: { value: ' New robot ' } });
    fireEvent.change(dialog().getByRole('textbox', { name: 'Description (optional)' }), { target: { value: ' Automated uploads ' } });
    fireEvent.click(dialog().getByRole('button', { name: 'Create integration' }));
    await waitFor(() => expect(call).toHaveBeenCalledWith('/admin/integrations', { method: 'POST', body: { name: 'New robot', description: 'Automated uploads' } }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
  it('returns the key only in its one-time dialog, copies on request and clears it on close and remount', async () => {
    const clipboard = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } });
    const view = await show();
    await generate();
    expect(dialog().getByRole('textbox', { name: 'One-time API key' })).toHaveValue(secret);
    expect(dialog().getByText(/This key is shown once/)).toBeVisible();
    const body = writes()[0][1]?.body;
    expect(body).toEqual({ label: 'Replacement', capabilities: ['call-for-sites.submit'], expiresAt: expect.any(String) });
    fireEvent.click(dialog().getByRole('button', { name: 'Copy key' }));
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith(secret));
    expect(JSON.stringify(localStorage)).not.toContain(secret);
    expect(JSON.stringify(sessionStorage)).not.toContain(secret);
    expect(window.location.href).not.toContain(secret);
    fireEvent.click(dialog().getByRole('button', { name: 'Close and clear key' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Generate key for Robot upload' }));
    expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
    view.unmount();
    await show();
    expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
  });
  it('offers manual copying if clipboard access fails without echoing the failure', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error(secret)) } });
    await show(); await generate();
    fireEvent.click(dialog().getByRole('button', { name: 'Copy key' }));
    expect(await dialog().findByRole('status')).toHaveTextContent('Copy unavailable. Select and copy the key manually.');
  });
  it.each(['create', 'key', 'rotate', 'toggle', 'revoke'] as const)('cancels %s without a write', async kind => {
    await show();
    const labels = { create: 'Create integration', key: 'Generate key for Robot upload', rotate: 'Rotate Robot key', toggle: 'Disable Robot upload', revoke: 'Revoke Robot key' };
    fireEvent.click(screen.getByRole('button', { name: labels[kind] }));
    fireEvent.click(dialog().getByRole('button', { name: 'Cancel' }));
    expect(writes()).toHaveLength(0);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
  it('validates label, safe scope and future expiry before generating', async () => {
    await show();
    fireEvent.click(screen.getByRole('button', { name: 'Generate key for Robot upload' }));
    fireEvent.click(dialog().getByRole('button', { name: 'Generate key' }));
    expect(dialog().getByRole('alert')).toHaveTextContent('Enter a name or label');
    fireEvent.change(dialog().getByRole('textbox', { name: 'Key label' }), { target: { value: 'Robot' } });
    fireEvent.click(dialog().getByRole('checkbox', { name: 'Call for Sites Submit' }));
    fireEvent.click(dialog().getByRole('button', { name: 'Generate key' }));
    expect(dialog().getByRole('alert')).toHaveTextContent('Select Call for Sites Submit');
    fireEvent.click(dialog().getByRole('checkbox', { name: 'Call for Sites Submit' }));
    fireEvent.change(dialog().getByLabelText('New key expiry (your local time)'), { target: { value: '2000-01-01T00:00' } });
    fireEvent.click(dialog().getByRole('button', { name: 'Generate key' }));
    expect(dialog().getByRole('alert')).toHaveTextContent('Select a future expiry');
    expect(writes()).toHaveLength(0);
    expect(dialog().getAllByRole('checkbox')).toHaveLength(1);
  });
  it('defaults rotation to immediate revocation and displays both returned effective expiries', async () => {
    await show();
    fireEvent.click(screen.getByRole('button', { name: 'Rotate Robot key' }));
    expect(dialog().getByRole('spinbutton', { name: 'Overlap hours' })).toHaveValue(0);
    fireEvent.click(dialog().getByRole('button', { name: 'Confirm rotation' }));
    await screen.findByRole('textbox', { name: 'One-time API key' });
    expect(writes()[0]).toEqual(['/admin/api-keys/key-id/rotate', { method: 'POST', body: { expiresAt: expect.any(String), overlapHours: 0 } }]);
    expect(dialog().getByText(/New key effective expiry:/)).toBeVisible();
    expect(dialog().getByText(/Previous key effective expiry:/)).toHaveTextContent('09/10/2026, 11:00:00');
  });
  it('rejects excessive overlap and sends an explicitly selected bounded overlap', async () => {
    await show();
    fireEvent.click(screen.getByRole('button', { name: 'Rotate Robot key' }));
    fireEvent.change(dialog().getByRole('spinbutton', { name: 'Overlap hours' }), { target: { value: '25' } });
    fireEvent.click(dialog().getByRole('button', { name: 'Confirm rotation' }));
    expect(dialog().getByRole('alert')).toHaveTextContent('between 0 and 24');
    expect(writes()).toHaveLength(0);
    fireEvent.change(dialog().getByRole('spinbutton', { name: 'Overlap hours' }), { target: { value: '12' } });
    fireEvent.click(dialog().getByRole('button', { name: 'Confirm rotation' }));
    await waitFor(() => expect(writes()[0][1]?.body).toMatchObject({ overlapHours: 12 }));
  });
  it.each([true, false])('confirms integration enabled=%s toggle and explains key consequences', async enabled => {
    await show({ ...integration, enabled });
    fireEvent.click(screen.getByRole('button', { name: `${enabled ? 'Disable' : 'Re-enable'} Robot upload` }));
    expect(dialog().getByRole('alert')).toHaveTextContent(enabled ? 'All its keys will stop working' : 'Expired and revoked keys will remain unusable');
    expect(writes()).toHaveLength(0);
    fireEvent.click(dialog().getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(call).toHaveBeenCalledWith('/admin/integrations/integration-id', { method: 'PATCH', body: { enabled: !enabled } }));
  });
  it('revokes an overlap key immediately only after confirmation', async () => {
    await show({ ...integration, keys: [{ ...key, status: 'SCHEDULED_REVOCATION' }] });
    expect(screen.getByRole('button', { name: 'Rotate Robot key' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Revoke Robot key' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Robot key' }));
    expect(dialog().getByRole('alert')).toHaveTextContent('including during a rotation overlap');
    fireEvent.click(dialog().getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(call).toHaveBeenCalledWith('/admin/api-keys/key-id/revoke', { method: 'POST' }));
  });
  it('retains inputs on backend failure and never echoes arbitrary error text', async () => {
    await show();
    fireEvent.click(screen.getByRole('button', { name: 'Generate key for Robot upload' }));
    fireEvent.change(dialog().getByRole('textbox', { name: 'Key label' }), { target: { value: 'Keep label' } });
    call.mockRejectedValueOnce(new ApiError(503, 'SERVICE_UNAVAILABLE', secret, 'safe-request_123'));
    fireEvent.click(dialog().getByRole('button', { name: 'Generate key' }));
    await waitFor(() => expect(dialog().getByRole('alert')).toHaveTextContent('Unable to complete this change'));
    expect(dialog().getByRole('alert')).toHaveTextContent('Request ID: safe-request_123');
    expect(dialog().getByRole('textbox', { name: 'Key label' })).toHaveValue('Keep label');
    expect(screen.queryByText(secret)).not.toBeInTheDocument();
  });
  it('refreshes permissions after denied writes and preserves the confirmation', async () => {
    const { refreshAccess } = await show();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Robot key' }));
    call.mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'Access denied'));
    fireEvent.click(dialog().getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(refreshAccess).toHaveBeenCalledOnce());
    expect(screen.getByRole('dialog')).toBeVisible();
  });
  it('refreshes permissions on a denied list and allows an explicit retry after a load failure', async () => {
    const refreshAccess = vi.fn(async () => {});
    call.mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'Unsafe upstream text'));
    call.mockResolvedValue({ integrations: [integration], total: 1, page: 1, pageSize: 50 });
    render(<IntegrationAdmin limits={limits} timezone="Europe/London" refreshAccess={refreshAccess} />);
    await waitFor(() => expect(refreshAccess).toHaveBeenCalledOnce());
    expect(screen.getByText('Unable to load integrations. Refresh to try again.')).toBeVisible();
    expect(screen.queryByText('Unsafe upstream text')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('heading', { name: 'Robot upload' })).toBeVisible();
  });
  it.each([['safe-list_123', true], ['<unsafe/request>', false]] as const)('shows only a safe request ID for a failed list: %s', async (requestId, visible) => {
    call.mockRejectedValue(new ApiError(503, 'SERVICE_UNAVAILABLE', secret, requestId));
    render(<IntegrationAdmin limits={limits} timezone="Europe/London" refreshAccess={vi.fn(async () => {})} />);
    const message = await screen.findByText(/Unable to load integrations/);
    expect(message.textContent?.includes('Request ID:')).toBe(visible);
    expect(message.textContent?.includes(requestId)).toBe(visible);
    expect(message.textContent?.includes(secret)).toBe(false);
  });
});

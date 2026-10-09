import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEventSummary } from '@planning/contracts';
import { AuditReview } from './AuditReview';
import { ApiError, request } from '../api';

vi.mock('../api', async importOriginal => ({ ...await importOriginal<typeof import('../api')>(), request: vi.fn() }));
const call = vi.mocked(request);
const id = '10000000-0000-4000-8000-000000000001';
const event: AuditEventSummary = { id, occurredAt: '2026-07-01T12:00:00.000Z', requestId: 'safe-request-1', actorType: 'INTEGRATION', actorUserId: null, actorIntegrationId: id, actorKeyId: '20000000-0000-4000-8000-000000000001', module: 'shared', action: 'API_KEY_REVOKED', targetType: 'api-key', targetId: id, outcome: 'SUCCESS', errorCode: null, channel: 'INTEGRATION_API', metadata: { capabilityCount: 1, enabled: false } };
const listing = { events: [event], total: 51, page: 1, pageSize: 50 };
beforeEach(() => { call.mockReset(); call.mockResolvedValue(listing); });
function show(refreshAccess = vi.fn(async () => {})) { render(<AuditReview timezone="America/New_York" refreshAccess={refreshAccess} />); return refreshAccess; }
const loaded = () => screen.findByRole('button', { name: `View event ${id}` });
function choose(label: string, value: string) { fireEvent.mouseDown(screen.getByRole('combobox', { name: label })); fireEvent.click(screen.getByRole('option', { name: value })); }

describe('audit review', () => {
  it('shows configured timezone, retained identity IDs and safe read-only details', async () => {
    show(); await loaded();
    expect(screen.getByText(/Dates are shown in America\/New_York/)).toBeVisible();
    expect(screen.getByText('01/07/2026, 08:00:00')).toBeVisible();
    expect(screen.getByText(`Integration: ${id}`)).toBeVisible();
    fireEvent.click(await loaded());
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText('Request ID: safe-request-1')).toBeVisible();
    expect(dialog.getByText('Channel: INTEGRATION_API')).toBeVisible();
    expect(dialog.getByText(/"capabilityCount": 1/)).toBeVisible();
    expect(dialog.getAllByRole('button')).toHaveLength(1);
    expect(dialog.queryByRole('textbox')).not.toBeInTheDocument();
    expect(call.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
  it('applies all filters explicitly, converts local dates to ISO and resets pagination', async () => {
    show(); await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Go to next page' }));
    await waitFor(() => expect(call.mock.calls.at(-1)?.[0]).toContain('page=2'));
    fireEvent.change(screen.getByLabelText('From (your local time)'), { target: { value: '2026-07-01T10:00' } });
    fireEvent.change(screen.getByLabelText('To (your local time)'), { target: { value: '2026-07-02T10:00' } });
    fireEvent.change(screen.getByLabelText('Actor ID'), { target: { value: id } });
    fireEvent.change(screen.getByLabelText('Target ID'), { target: { value: id } });
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: ' USERS_LIST ' } });
    choose('Actor type', 'USER'); choose('Module', 'Shared'); choose('Outcome', 'DENIED');
    expect(call.mock.calls.at(-1)?.[0]).toContain('page=2');
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => expect(call.mock.calls.at(-1)?.[0]).toContain('action=USERS_LIST'));
    const query = new URLSearchParams((call.mock.calls.at(-1)?.[0] as string).split('?')[1]);
    expect(Object.fromEntries(query)).toEqual({ page: '1', dateFrom: new Date('2026-07-01T10:00').toISOString(), dateTo: new Date('2026-07-02T10:00').toISOString(), actorType: 'USER', actorId: id, module: 'shared', action: 'USERS_LIST', outcome: 'DENIED', targetId: id });
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    await waitFor(() => expect(call.mock.calls.at(-1)?.[0]).toBe('/admin/audit-events?page=1'));
  });
  it('rejects malformed IDs and inverted intervals before sending a request', async () => {
    show(); await loaded();
    fireEvent.change(screen.getByLabelText('Actor ID'), { target: { value: 'bad-id' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid UUID');
    fireEvent.change(screen.getByLabelText('Actor ID'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('From (your local time)'), { target: { value: '2026-07-02T10:00' } });
    fireEvent.change(screen.getByLabelText('To (your local time)'), { target: { value: '2026-07-01T10:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(screen.getByRole('alert')).toHaveTextContent('start before the end');
    expect(call).toHaveBeenCalledOnce();
  });
  it('shows an empty result and prevents unavailable pagination', async () => {
    call.mockResolvedValue({ ...listing, events: [], total: 0 }); show();
    expect(await screen.findByText('No audit events match these filters.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Go to next page' })).toBeDisabled();
  });
  it('validates action codes before requesting and permits the full 100 character limit', async () => {
    show(); await loaded();
    const action = screen.getByLabelText('Action');
    expect(action).toHaveAttribute('maxlength', '100');
    for (const value of ['users_list', '1USERS', 'USERS LIST', 'A'.repeat(101)]) {
      fireEvent.change(action, { target: { value } });
      fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
      expect(screen.getByRole('alert')).toHaveTextContent('Enter an action code');
    }
    expect(call).toHaveBeenCalledOnce();
    fireEvent.change(action, { target: { value: 'A'.repeat(100) } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => expect(call.mock.calls.at(-1)?.[0]).toContain(`action=${'A'.repeat(100)}`));
  });
  it('shows a safe request reference and retries without echoing an error body', async () => {
    call.mockRejectedValueOnce(new ApiError(503, 'INTERNAL_ERROR', 'SQL credential=secret', 'safe-id')); show();
    expect(await screen.findByRole('alert')).toHaveTextContent('Request ID: safe-id');
    expect(screen.queryByText(/credential/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await loaded();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it.each([401, 403])('refreshes current access on %i and removes stale data', async status => {
    const refresh = show(); await loaded();
    call.mockRejectedValueOnce(new ApiError(status, 'FORBIDDEN', 'Internal identity detail'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText(/Internal identity/)).not.toBeInTheDocument();
  });
  it('aborts replaced requests and ignores stale responses', async () => {
    let resolveFirst!: (value: unknown) => void;
    call.mockImplementationOnce(() => new Promise<never>(resolve => { resolveFirst = value => resolve(value as never); })); show();
    expect(screen.getByRole('status')).toHaveTextContent('Loading audit events');
    const firstSignal = call.mock.calls[0][1]?.signal;
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'USERS_LIST' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' })); await loaded();
    expect(firstSignal?.aborted).toBe(true);
    resolveFirst({ ...listing, events: [], total: 0 });
    await waitFor(() => expect(screen.getByRole('table')).toBeVisible());
  });
});

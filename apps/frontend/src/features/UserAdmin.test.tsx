import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserAdmin } from './UserAdmin';
import { ApiError, request } from '../api';
import type { User } from '../types';

vi.mock('../api', async importOriginal => ({ ...await importOriginal<typeof import('../api')>(), request: vi.fn() }));
const call = vi.mocked(request);
const administrator: User = { id: 'admin-id', subject: 'local:admin', email: 'admin@example.test', displayName: 'Administrator', role: 'ADMIN', status: 'APPROVED', createdAt: '', updatedAt: '', lastLoginAt: null, approvedAt: null, approvedByUserId: null };
const target: User = { ...administrator, id: 'target-id', subject: 'local:target', email: 'target@example.test', displayName: 'Target', role: 'USER', status: 'PENDING' };
beforeEach(() => { call.mockReset(); });

async function open(status: User['status'] = 'PENDING', refreshAccess = vi.fn(async () => {})) {
  call.mockImplementation(async (_path, options) => (options?.method ? { ...target, status } : { users: [{ ...target, status }], total: 51 }) as never);
  render(<UserAdmin currentUser={administrator} refreshAccess={refreshAccess} />);
  await screen.findByRole('button', { name: 'Manage Target' });
  fireEvent.click(screen.getByRole('button', { name: 'Manage Target' }));
  return { dialog: screen.getByRole('dialog'), refreshAccess };
}

describe('user administration contracts', () => {
  it.each([
    ['PENDING', 'Approve', 'approve'], ['PENDING', 'Reject', 'reject'],
    ['APPROVED', 'Disable account', 'disable'], ['DISABLED', 'Return to pending approval', 'enable'],
    ['REJECTED', 'Return to pending approval', 'enable'],
  ] as const)('confirms %s action %s and posts without a business body', async (status, label, action) => {
    const { dialog, refreshAccess } = await open(status);
    fireEvent.click(within(dialog).getByRole('button', { name: label }));
    expect(call.mock.calls.filter(([, options]) => options?.method)).toHaveLength(0);
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/Confirm/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(call).toHaveBeenCalledWith(`/admin/users/target-id/${action}`, { method: 'POST' }));
    await waitFor(() => expect(refreshAccess).toHaveBeenCalledOnce());
  });
  it('changes the role independently using the role endpoint', async () => {
    const { dialog } = await open();
    fireEvent.mouseDown(within(dialog).getByRole('combobox', { name: 'Application role' }));
    fireEvent.click(screen.getByRole('option', { name: 'ADMIN' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save role' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('The new role will be ADMIN.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(call).toHaveBeenCalledWith('/admin/users/target-id/role', { method: 'PATCH', body: { role: 'ADMIN' } }));
  });
  it('uses fixed pages of 50, role and text filters and resets the page when filtering', async () => {
    call.mockResolvedValue({ users: [target], total: 51 });
    render(<UserAdmin currentUser={administrator} refreshAccess={vi.fn(async () => {})} />);
    await screen.findByRole('button', { name: 'Manage Target' });
    expect(screen.getByText('1–50 of 51')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Go to next page' }));
    await waitFor(() => expect(call.mock.calls.at(-1)?.[0]).toContain('page=2'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search name or email' }), { target: { value: 'Ada' } });
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Filter by role' }));
    fireEvent.click(screen.getByRole('option', { name: 'ADMIN' }));
    await waitFor(() => expect(call.mock.calls.at(-1)?.[0]).toBe('/admin/users?page=1&text=Ada&role=ADMIN'));
  });
  it('retains the dialog and refreshes local capabilities after an access denial', async () => {
    const { dialog, refreshAccess } = await open();
    call.mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'Administrator access is required.'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(refreshAccess).toHaveBeenCalledOnce());
    expect(within(dialog).getByText('Administrator access is required.')).toBeInTheDocument();
  });
});

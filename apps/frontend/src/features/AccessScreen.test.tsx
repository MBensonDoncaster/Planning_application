import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AccessScreen } from './AccessScreen';
import type { User } from '../types';

const user: User = {
  id: 'a', subject: 'local:a', displayName: 'Ada', email: 'ada@example.test', role: 'ADMIN', status: 'PENDING',
  createdAt: '', updatedAt: '', lastLoginAt: null, approvedAt: null, approvedByUserId: null,
};
describe('unapproved access', () => {
  it('keeps an ADMIN with pending status on the approval screen and allows refresh', () => {
    const refresh = vi.fn();
    render(<AccessScreen user={user} refresh={refresh} />);
    expect(screen.getByRole('heading', { name: 'Awaiting administrator approval' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh access' }));
    expect(refresh).toHaveBeenCalledOnce();
  });
  it.each(['REJECTED', 'DISABLED'] as const)('explains %s access', status => {
    render(<AccessScreen user={{ ...user, status }} refresh={() => {}} />);
    expect(screen.getByText(/Contact your application administrator/)).toBeInTheDocument();
  });
});

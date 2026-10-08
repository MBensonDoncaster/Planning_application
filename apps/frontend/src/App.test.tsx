import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { ApiError, hasSession, initializeAuth, request } from './api';

vi.mock('./api', async importOriginal => ({
  ...await importOriginal<typeof import('./api')>(),
  initializeAuth: vi.fn(),
  hasSession: vi.fn(),
  request: vi.fn(),
}));

describe('unexpected API failures in the application', () => {
  it('shows the safe server message and request ID in the rendered error alert', async () => {
    vi.mocked(initializeAuth).mockRejectedValueOnce(new ApiError(503, 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable.', 'req-ui'));
    render(<MemoryRouter><App /></MemoryRouter>);
    expect(await screen.findByRole('alert')).toHaveTextContent('The service is temporarily unavailable. Request ID: req-ui');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
  });
  it('does not request application configuration for an unapproved account', async () => {
    vi.mocked(initializeAuth).mockResolvedValueOnce({ appName: 'Planning', mode: 'TEST_USER' });
    vi.mocked(hasSession).mockReturnValue(true);
    vi.mocked(request).mockClear().mockResolvedValueOnce({ status: 'PENDING', role: 'ADMIN', displayName: 'Developer', email: 'dev@example.test' });
    render(<MemoryRouter initialEntries={['/call-for-sites']}><App /></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: 'Awaiting administrator approval' })).toBeVisible();
    expect(request).toHaveBeenCalledExactlyOnceWith('/auth/me');
  });
  it('shows a retry and request ID if approved-user configuration cannot load', async () => {
    vi.mocked(initializeAuth).mockResolvedValueOnce({ appName: 'Planning', mode: 'ENTRA' });
    vi.mocked(hasSession).mockReturnValue(true);
    vi.mocked(request).mockClear().mockResolvedValueOnce({ status: 'APPROVED', role: 'USER', displayName: 'Developer' })
      .mockRejectedValueOnce(new ApiError(503, 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable.', 'req-config'));
    render(<MemoryRouter><App /></MemoryRouter>);
    expect(await screen.findByRole('button', { name: 'Retry application' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('Request ID: req-config');
    expect(request).toHaveBeenNthCalledWith(2, '/app/config');
  });
});

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { ApiError, initializeAuth } from './api';

vi.mock('./api', async importOriginal => ({
  ...await importOriginal<typeof import('./api')>(),
  initializeAuth: vi.fn(),
}));

describe('unexpected API failures in the application', () => {
  it('shows the safe server message and request ID in the rendered error alert', async () => {
    vi.mocked(initializeAuth).mockRejectedValueOnce(new ApiError(503, 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable.', 'req-ui'));
    render(<MemoryRouter><App /></MemoryRouter>);
    expect(await screen.findByRole('alert')).toHaveTextContent('The service is temporarily unavailable. Request ID: req-ui');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
  });
});

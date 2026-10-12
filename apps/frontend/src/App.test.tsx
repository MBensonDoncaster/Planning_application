import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MODULE_REGISTRY, ROLE_CAPABILITIES, type AppConfig, type SessionResponse, type SessionUser } from '@planning/contracts';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { ApiError, hasSession, initializeAuth, request } from './api';

vi.mock('./api', async importOriginal => ({
  ...await importOriginal<typeof import('./api')>(),
  initializeAuth: vi.fn(),
  hasSession: vi.fn(),
  request: vi.fn(),
}));

const user: SessionUser = {
  id: 'user-1', subject: 'local:developer', email: 'dev@example.test', displayName: 'Developer',
  status: 'APPROVED', role: 'ADMIN', createdAt: '', updatedAt: '',
  lastLoginAt: null, approvedAt: null, approvedByUserId: null,
};
const appConfig: AppConfig = {
  appName: 'Planning', businessTimezone: 'Europe/London', enabledModules: MODULE_REGISTRY,
  limits: {
    ingestionMaxBodyBytes: 10485760, uploadMaxFileBytes: 5242880, zipMaxEntries: 1000, jsonMaxDepth: 100,
    geojsonMaxPositions: 100000, exportMaxSelection: 500, exportMaxBytes: 104857600,
    exportGenerationTimeoutMs: 30000, exportDownloadTimeoutMs: 120000, idempotencyRetentionDays: 30,
    apiKeyDefaultExpiryDays: 90, apiKeyMaxExpiryDays: 365,
  },
};

beforeEach(() => {
  vi.mocked(initializeAuth).mockReset();
  vi.mocked(hasSession).mockReset();
  vi.mocked(request).mockReset();
});

async function renderApp(path = '/') {
  // Flush initial updates and passive effects before dispatching focus events.
  await act(async () => {
    render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
  });
}

describe('unexpected API failures in the application', () => {
  it('shows the safe server message and request ID in the rendered error alert', async () => {
    vi.mocked(initializeAuth).mockRejectedValueOnce(new ApiError(503, 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable.', 'req-ui'));
    await renderApp();
    expect(await screen.findByRole('alert')).toHaveTextContent('The service is temporarily unavailable. Request ID: req-ui');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
  });
  it('does not request application configuration for an unapproved account', async () => {
    vi.mocked(initializeAuth).mockResolvedValueOnce({ appName: 'Planning', mode: 'TEST_USER' });
    vi.mocked(hasSession).mockReturnValue(true);
    vi.mocked(request).mockResolvedValueOnce({ user: { status: 'PENDING', role: 'ADMIN', displayName: 'Developer', email: 'dev@example.test' }, capabilities: ['users.manage'] });
    await renderApp('/call-for-sites');
    expect(await screen.findByRole('heading', { name: 'Awaiting administrator approval' })).toBeVisible();
    expect(request).toHaveBeenCalledExactlyOnceWith('/auth/me');
  });
  it('shows a retry and request ID if approved-user configuration cannot load', async () => {
    vi.mocked(initializeAuth).mockResolvedValueOnce({ appName: 'Planning', mode: 'ENTRA' });
    vi.mocked(hasSession).mockReturnValue(true);
    vi.mocked(request).mockResolvedValueOnce({ user: { status: 'APPROVED', role: 'USER', displayName: 'Developer' }, capabilities: ['call-for-sites.read'] })
      .mockRejectedValueOnce(new ApiError(503, 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable.', 'req-config'));
    await renderApp();
    expect(await screen.findByRole('button', { name: 'Retry application' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('Request ID: req-config');
    expect(request).toHaveBeenNthCalledWith(2, '/app/config');
  });
  it('removes navigation and direct-route access when a focus refresh revokes capabilities', async () => {
    vi.mocked(initializeAuth).mockResolvedValueOnce({ appName: 'Planning', mode: 'TEST_USER' });
    vi.mocked(hasSession).mockReturnValue(true);
    vi.mocked(request)
      .mockResolvedValueOnce({ user, capabilities: ROLE_CAPABILITIES.ADMIN })
      .mockResolvedValueOnce(appConfig)
      .mockResolvedValueOnce({ user, capabilities: ['call-for-sites.read'] })
      .mockResolvedValueOnce(appConfig);
    await renderApp('/call-for-sites/upload');
    expect(await screen.findByRole('heading', { name: 'Upload files' })).toBeVisible();
    expect(screen.getByRole('link', { name: /Administration/ })).toBeVisible();
    await act(async () => { fireEvent(window, new Event('focus')); });
    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeVisible();
    expect(screen.queryByRole('link', { name: /Administration/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Upload files' })).not.toBeInTheDocument();
    await waitFor(() => expect(request).toHaveBeenCalledTimes(4));
  });
  it('clears stale capabilities when session refresh fails', async () => {
    vi.mocked(initializeAuth).mockResolvedValueOnce({ appName: 'Planning', mode: 'TEST_USER' });
    vi.mocked(hasSession).mockReturnValue(true);
    vi.mocked(request)
      .mockResolvedValueOnce({ user, capabilities: ROLE_CAPABILITIES.ADMIN })
      .mockResolvedValueOnce(appConfig)
      .mockRejectedValueOnce(new ApiError(503, 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable.', 'req-refresh'));
    await renderApp('/call-for-sites');
    expect(await screen.findByRole('heading', { name: 'Browse submissions' })).toBeVisible();
    await act(async () => { fireEvent(window, new Event('focus')); });
    expect(await screen.findByRole('button', { name: 'Retry application' })).toBeVisible();
    expect(screen.queryByRole('link', { name: /Administration/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Call for Sites' })).not.toBeInTheDocument();
  });
  it('ignores an older refresh response after a newer response revoked access', async () => {
    vi.mocked(initializeAuth).mockResolvedValueOnce({ appName: 'Planning', mode: 'TEST_USER' });
    vi.mocked(hasSession).mockReturnValue(true);
    let finishOlder!: (session: SessionResponse) => void;
    const olderResponse = new Promise<SessionResponse>(resolve => { finishOlder = resolve; });
    vi.mocked(request)
      .mockResolvedValueOnce({ user, capabilities: ROLE_CAPABILITIES.ADMIN })
      .mockResolvedValueOnce(appConfig)
      .mockReturnValueOnce(olderResponse)
      .mockResolvedValueOnce({ user: { ...user, status: 'DISABLED' }, capabilities: [] });
    await renderApp('/call-for-sites/upload');
    expect(await screen.findByRole('heading', { name: 'Upload files' })).toBeVisible();
    await act(async () => {
      fireEvent(window, new Event('focus'));
      fireEvent(window, new Event('focus'));
    });
    expect(await screen.findByRole('heading', { name: 'Your account is disabled' })).toBeVisible();
    await act(async () => { finishOlder({ user, capabilities: ROLE_CAPABILITIES.ADMIN }); });
    expect(screen.getByRole('heading', { name: 'Your account is disabled' })).toBeVisible();
    expect(screen.queryByRole('link', { name: /Administration/ })).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(4);
  });
});

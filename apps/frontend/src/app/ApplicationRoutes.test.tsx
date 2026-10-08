import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { MODULE_REGISTRY, type AppConfig } from '@planning/contracts';
import { ApplicationRoutes } from './ApplicationRoutes';
import { AppHeader } from '../components/AppHeader';
import type { User } from '../types';

vi.mock('../features/UserAdmin', () => ({ UserAdmin: () => <h1>User administration</h1> }));
const user: User = { id: 'user-1', subject: 'local:developer', email: 'dev@example.test', displayName: 'Developer', role: 'USER', status: 'APPROVED', createdAt: '', updatedAt: '', lastLoginAt: null, approvedAt: null, approvedByUserId: null };
const config: AppConfig = { appName: 'Planning', businessTimezone: 'Europe/London', enabledModules: MODULE_REGISTRY, limits: {
  ingestionMaxBodyBytes: 10485760, uploadMaxFileBytes: 5242880, zipMaxEntries: 1000, jsonMaxDepth: 100,
  geojsonMaxPositions: 100000, exportMaxSelection: 500, exportMaxBytes: 104857600,
  exportGenerationTimeoutMs: 30000, exportDownloadTimeoutMs: 120000, idempotencyRetentionDays: 30,
  apiKeyDefaultExpiryDays: 90, apiKeyMaxExpiryDays: 365,
} };
function show(path: string, actor = user, settings: AppConfig | undefined = config) {
  const refresh = vi.fn().mockResolvedValue(undefined);
  render(<MemoryRouter initialEntries={[path]}><ApplicationRoutes user={actor} config={settings} refreshAccess={refresh} /></MemoryRouter>);
  return refresh;
}
describe('application routes and navigation', () => {
  it('lands on browse and uses the runtime timezone', async () => {
    show('/', user, { ...config, businessTimezone: 'America/New_York' });
    expect(await screen.findByRole('heading', { name: 'Browse submissions' })).toBeVisible();
    expect(screen.getByText('Dates are shown in America/New_York.')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Delete a submission' })).not.toBeInTheDocument();
  });
  it.each(MODULE_REGISTRY[0].routes)('renders the prescribed $id route', async route => {
    show(route.path.replace(':id', 'record-1'), { ...user, role: 'ADMIN' });
    expect(await screen.findByRole('heading', { name: route.label })).toBeVisible();
    expect(screen.getByText('This function is not yet available.')).toBeVisible();
  });
  it.each(['/call-for-sites/delete', '/admin', '/admin/users', '/admin/integrations', '/admin/audit'])('denies USER direct access to %s', async path => {
    show(path);
    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeVisible();
  });
  it.each([
    ['PENDING', 'Awaiting administrator approval'], ['REJECTED', 'Access request declined'], ['DISABLED', 'Your account is disabled'],
  ] as const)('redirects %s administrators to their account screen', async (status, title) => {
    show('/call-for-sites/upload', { ...user, role: 'ADMIN', status });
    expect(await screen.findByRole('heading', { name: title })).toBeVisible();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });
  it.each([['/admin', 'Administration'], ['/admin/users', 'User administration'], ['/admin/integrations', 'Integrations'], ['/admin/audit', 'Audit']])('allows ADMIN on %s', async (path, title) => {
    show(path, { ...user, role: 'ADMIN' });
    expect(await screen.findByRole('heading', { name: title })).toBeVisible();
  });
  it('does not expose routes for a module absent from runtime configuration', async () => {
    show('/call-for-sites', user, { ...config, enabledModules: [] });
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeVisible();
  });
  it('offers a retry when approved-user configuration failed to load', () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    render(<MemoryRouter><ApplicationRoutes user={user} refreshAccess={refresh} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Retry application' }));
    expect(refresh).toHaveBeenCalledOnce();
  });
  it.each(['APPROVED', 'PENDING'] as const)('keeps header links appropriate for %s status and preserves sign out', status => {
    const signOut = vi.fn();
    render(<MemoryRouter><AppHeader user={{ ...user, role: 'ADMIN', status }} modules={MODULE_REGISTRY} canSignOut onSignOut={signOut} /></MemoryRouter>);
    const nav = within(screen.getByRole('navigation', { name: 'Main navigation' }));
    if (status === 'APPROVED') {
      expect(nav.getByRole('link', { name: 'Call for Sites' })).toHaveAttribute('href', '/call-for-sites');
      expect(nav.getByRole('link', { name: /Administration/ })).toHaveAttribute('href', '/admin');
    } else expect(nav.queryByRole('link')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalledOnce();
  });
});

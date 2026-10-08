import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Container, Paper, Stack, Typography } from '@mui/material';
import type { AppConfig } from '@planning/contracts';
import { ApiError, errorMessage, hasSession, initializeAuth, request, signIn, signOut } from './api';
import type { AuthConfig, User } from './types';
import { PageBanner } from './components/PageBanner';
import { AppHeader } from './components/AppHeader';
import { ApplicationRoutes } from './app/ApplicationRoutes';

export function App() {
  const [config, setConfig] = useState<AuthConfig>();
  const [user, setUser] = useState<User>();
  const [appConfig, setAppConfig] = useState<AppConfig>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    setError('');
    try {
      const nextUser = await request<User>('/auth/me');
      setUser(nextUser);
      if (nextUser.status === 'APPROVED') setAppConfig(await request<AppConfig>('/app/config'));
      else setAppConfig(undefined);
    }
    catch (e) {
      if (e instanceof ApiError && e.status === 401) setUser(undefined);
      setAppConfig(undefined);
      setError(errorMessage(e, 'Unable to load your account.'));
    }
  }, []);
  useEffect(() => {
    void initializeAuth().then(async c => {
      setConfig(c); document.title = c.appName;
      if (hasSession()) await refresh();
    }).catch(e => setError(errorMessage(e, 'Unable to initialize sign-in.'))).finally(() => setLoading(false));
  }, [refresh]);
  // Refresh approval/role while the page stays open; API remains authoritative.
  useEffect(() => {
    if (!user) return;
    const timer = window.setInterval(() => void refresh(), 60_000);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [Boolean(user), refresh]);
  const run = (action: () => Promise<void>) => { void action().catch(e => setError(errorMessage(e, 'Sign-in failed.'))); };
  if (loading) return <Box sx={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}><CircularProgress aria-label="Loading application" /></Box>;
  return <>
    <AppHeader user={user} modules={appConfig?.enabledModules} canSignOut={config?.mode === 'ENTRA'} onSignOut={() => run(signOut)} />
    <Container component="main" maxWidth={false} sx={{ px: { xs: 2, md: 2.5 }, py: 3.5 }}>
      {config?.mode === 'TEST_USER' && <Alert severity="warning" sx={{ mb: 3 }}>Local development mode · SSO is bypassed for a single test identity.</Alert>}
      {error && <Alert severity="error" sx={{ mb: 3 }}>{error}</Alert>}
      {!config ? <Button onClick={() => window.location.reload()}>Retry</Button> :
        !user ? <Box sx={{ maxWidth: 680, mx: 'auto', mt: { xs: 1, md: 5 } }}><PageBanner title={`Welcome to ${config.appName}`} description="Sign in to your application" kind="shield" /><Paper variant="outlined" sx={{ p: { xs: 3, md: 4 }, borderRadius: '0 0 12px 12px' }}><Stack spacing={3}>
          <Typography color="text.secondary">Sign in with your work account to continue. New accounts require administrator approval.</Typography>
          <Button variant="contained" onClick={() => config.mode === 'ENTRA' ? run(signIn) : void refresh()}>Sign in with Microsoft</Button>
        </Stack></Paper></Box> : <ApplicationRoutes user={user} config={appConfig} refreshAccess={refresh} />}
    </Container>
  </>;
}

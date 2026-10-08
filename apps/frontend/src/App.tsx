import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { Alert, Box, Button, Chip, CircularProgress, Container, Paper, Stack, Typography } from '@mui/material';
import { ApiError, hasSession, initializeAuth, request, signIn, signOut } from './api';
import type { AuthConfig, User } from './types';
import { AccessScreen } from './features/AccessScreen';
import { UserAdmin } from './features/UserAdmin';
import { PageBanner } from './components/PageBanner';
import { ThemeIcon } from './components/ThemeIcon';
import { design } from './theme';
import { AppHeader } from './components/AppHeader';

export function App() {
  const [config, setConfig] = useState<AuthConfig>();
  const [user, setUser] = useState<User>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    setError('');
    try { setUser(await request<User>('/auth/me')); }
    catch (e) {
      if (e instanceof ApiError && e.status === 401) setUser(undefined);
      setError(e instanceof Error ? e.message : 'Unable to load your account.');
    }
  }, []);
  useEffect(() => {
    void initializeAuth().then(async c => {
      setConfig(c); document.title = c.appName;
      if (hasSession()) await refresh();
    }).catch(e => setError(e instanceof Error ? e.message : 'Unable to initialize sign-in.')).finally(() => setLoading(false));
  }, [refresh]);
  // Refresh approval/role while the page stays open; API remains authoritative.
  useEffect(() => {
    if (!user) return;
    const timer = window.setInterval(() => void refresh(), 60_000);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [Boolean(user), refresh]);
  const run = (action: () => Promise<void>) => { void action().catch(e => setError(e instanceof Error ? e.message : 'Sign-in failed.')); };
  if (loading) return <Box sx={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}><CircularProgress aria-label="Loading application" /></Box>;
  return <>
    <AppHeader user={user} canSignOut={config?.mode === 'ENTRA'} onSignOut={() => run(signOut)} />
    <Container component="main" maxWidth={false} sx={{ px: { xs: 2, md: 2.5 }, py: 3.5 }}>
      {config?.mode === 'TEST_USER' && <Alert severity="warning" sx={{ mb: 3 }}>Local development mode · SSO is bypassed for a single test identity.</Alert>}
      {error && <Alert severity="error" sx={{ mb: 3 }}>{error}</Alert>}
      {!config ? <Button onClick={() => window.location.reload()}>Retry</Button> :
        !user ? <Box sx={{ maxWidth: 680, mx: 'auto', mt: { xs: 1, md: 5 } }}><PageBanner title={`Welcome to ${config.appName}`} description="Sign in to your application" kind="shield" /><Paper variant="outlined" sx={{ p: { xs: 3, md: 4 }, borderRadius: '0 0 12px 12px' }}><Stack spacing={3}>
          <Typography color="text.secondary">Sign in with your work account to continue. New accounts require administrator approval.</Typography>
          <Button variant="contained" onClick={() => config.mode === 'ENTRA' ? run(signIn) : void refresh()}>Sign in with Microsoft</Button>
        </Stack></Paper></Box> : user.status !== 'APPROVED' ? <AccessScreen user={user} refresh={() => void refresh()} /> :
          <Routes>
            <Route path="/" element={<Home user={user} appName={config.appName} refresh={refresh} />} />
            <Route path="/admin" element={<Navigate to="/admin/users" replace />} />
            <Route path="/admin/users" element={user.role === 'ADMIN' ? <UserAdmin currentUser={user} refreshAccess={refresh} /> : <Navigate to="/" replace />} />
            <Route path="*" element={<Stack spacing={2}><Typography variant="h4" component="h1">Page not found</Typography><Button component={Link} to="/">Back to home</Button></Stack>} />
          </Routes>}
    </Container>
  </>;
}

function Home({ user, appName, refresh }: { user: User; appName: string; refresh: () => Promise<void> }) {
  const [error, setError] = useState('');
  useEffect(() => { void request('/home').catch(e => {
    setError(e instanceof Error ? e.message : 'Unable to load the homepage.');
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) void refresh();
  }); }, [refresh]);
  return <Stack spacing={3}>
    {error && <Alert severity="error">{error}</Alert>}
    <PageBanner title={`Welcome, ${user.displayName}.`} description={`Your ${appName} homepage`} actions={<Button variant="outlined" startIcon={<ThemeIcon kind="refresh" />} onClick={() => void refresh()}>Refresh access</Button>} />
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: user.role === 'ADMIN' ? '1.4fr 1fr' : '1fr' }, gap: 2.5, px: { xs: 0, md: 3 } }}>
      <Paper variant="outlined" sx={{ p: 3, borderLeft: `4px solid ${design.magenta}` }}><Stack spacing={2}>
        <Stack direction="row" spacing={1} alignItems="center"><ThemeIcon kind="home" color="primary" fontSize="small" /><Typography variant="h6" color="primary">Your account is ready</Typography></Stack>
        <Typography variant="body2">You’re signed in to {appName}. This is your application homepage.</Typography>
        <Stack direction="row" spacing={1}><Chip label="Access approved" color="success" variant="outlined" size="small" /><Chip label={user.role === 'ADMIN' ? 'Administrator' : 'User'} size="small" variant="outlined" /></Stack>
      </Stack></Paper>
      {user.role === 'ADMIN' && <Paper variant="outlined" sx={{ p: 3, borderTop: `4px solid ${design.magenta}` }}><Stack spacing={2}>
        <Stack direction="row" spacing={1} alignItems="center"><ThemeIcon kind="users" color="primary" fontSize="small" /><Typography variant="h6" color="primary">User administration</Typography></Stack>
        <Typography variant="body2" color="text.secondary">Review access requests and manage user roles.</Typography>
        <Button component={Link} to="/admin/users" variant="contained" endIcon={<ThemeIcon kind="arrow" />} sx={{ alignSelf: 'start' }}>Manage users</Button>
      </Stack></Paper>}
    </Box>
  </Stack>;
}

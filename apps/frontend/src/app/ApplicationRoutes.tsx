import { ADMIN_ROUTES, type AppConfig, type Capability, type ModuleDefinition, type ModuleRoute } from '@planning/contracts';
import { Alert, Button, Paper, Stack, Typography } from '@mui/material';
import { Link, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import type { User } from '../types';
import { AccessScreen } from '../features/AccessScreen';
import { UserAdmin } from '../features/UserAdmin';
import { IntegrationAdmin } from '../features/IntegrationAdmin';
import { PageBanner } from '../components/PageBanner';
import { canAccess } from './access';

function AccessDenied() {
  return <Stack spacing={2}>
    <PageBanner title="Access denied" description="Your account cannot use this function." kind="shield" />
    <Button component={Link} to="/call-for-sites" sx={{ alignSelf: 'start' }}>Back to Call for Sites</Button>
  </Stack>;
}

function FunctionShell({ title, description }: { title: string; description: string }) {
  return <Stack spacing={2}>
    <PageBanner title={title} description={description} />
    <Alert severity="info">This function is not yet available.</Alert>
  </Stack>;
}

function ModulePage({ module, route, user, capabilities, timezone }: { module: ModuleDefinition; route: ModuleRoute; user: User; capabilities: readonly Capability[]; timezone: string }) {
  if (!canAccess(user, capabilities, route.capability)) return <AccessDenied />;
  return <Stack spacing={2}>
    <Stack component="nav" aria-label="Call for Sites navigation" direction="row" spacing={1} flexWrap="wrap" useFlexGap>
      {module.routes.filter(item => item.id !== 'record' && canAccess(user, capabilities, item.capability)).map(item =>
        <Button component={NavLink} key={item.id} to={item.path} end={item.id === 'browse'} sx={{ '&.active': { textDecoration: 'underline' } }}>{item.label}</Button>)}
    </Stack>
    <FunctionShell title={route.label} description={route.description} />
    <Typography variant="body2" color="text.secondary">Dates are shown in {timezone}.</Typography>
  </Stack>;
}

export function ApplicationRoutes({ user, capabilities, config, refreshAccess }: { user: User; capabilities: readonly Capability[]; config?: AppConfig; refreshAccess: () => Promise<void> }) {
  if (user.status !== 'APPROVED') {
    return <Routes>
      <Route path="/access" element={<AccessScreen user={user} refresh={() => void refreshAccess()} />} />
      <Route path="*" element={<Navigate to="/access" replace />} />
    </Routes>;
  }
  if (!config) return <Button onClick={() => void refreshAccess()}>Retry application</Button>;
  const landing = config.enabledModules[0]?.path ?? '/admin';
  return <Routes>
    <Route path="/" element={<Navigate to={landing} replace />} />
    <Route path="/access" element={<Navigate to={landing} replace />} />
    {config.enabledModules.flatMap(module => module.routes.map(route =>
      <Route key={route.path} path={route.path} element={<ModulePage module={module} route={route} user={user} capabilities={capabilities} timezone={config.businessTimezone} />} />))}
    <Route path="/admin" element={canAccess(user, capabilities, 'users.manage') ? <Stack spacing={2}>
      <PageBanner title="Administration" description="Manage application access, integrations and audit." kind="users" />
      {ADMIN_ROUTES.filter(route => canAccess(user, capabilities, route.capability)).map(route =>
        <Paper key={route.path} variant="outlined" sx={{ p: 2 }}>
          <Button component={Link} to={route.path}>{route.label}</Button><Typography variant="body2">{route.description}</Typography>
        </Paper>)}
    </Stack> : <AccessDenied />} />
    {ADMIN_ROUTES.map(route => <Route key={route.path} path={route.path} element={canAccess(user, capabilities, route.capability) ?
      <Stack spacing={2}>
        <Stack component="nav" aria-label="Administration navigation" direction="row" spacing={1}>
          {ADMIN_ROUTES.filter(item => canAccess(user, capabilities, item.capability)).map(item => <Button component={NavLink} key={item.path} to={item.path} sx={{ '&.active': { textDecoration: 'underline' } }}>{item.label}</Button>)}
        </Stack>
        {route.path === '/admin/users' ? <UserAdmin currentUser={user} refreshAccess={refreshAccess} /> : route.path === '/admin/integrations' ? <IntegrationAdmin limits={config.limits} timezone={config.businessTimezone} refreshAccess={refreshAccess} /> : <FunctionShell title={route.label} description={route.description} />}
      </Stack> : <AccessDenied />} />)}
    <Route path="*" element={<Stack spacing={2}><Typography variant="h4" component="h1">Page not found</Typography><Button component={Link} to={landing}>Back to Call for Sites</Button></Stack>} />
  </Routes>;
}

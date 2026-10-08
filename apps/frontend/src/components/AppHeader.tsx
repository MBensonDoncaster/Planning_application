import { Link, NavLink } from 'react-router-dom';
import type { ModuleDefinition } from '@planning/contracts';
import { Avatar, Box, Button, Stack, Typography } from '@mui/material';
import type { User } from '../types';
import { design } from '../theme';
import { canAccess } from '../app/access';

export function AppHeader({ user, modules = [], canSignOut, onSignOut }: { user?: User; modules?: readonly ModuleDefinition[]; canSignOut: boolean; onSignOut: () => void }) {
  return <Box component="header" sx={{
    bgcolor: '#333333', color: '#fff', borderBottom: `3px solid ${design.teal}`,
    display: 'grid', alignItems: 'center',
    gridTemplateColumns: { xs: '1fr auto', md: '232px minmax(0, 1fr) auto' },
    gridTemplateAreas: { xs: '"brand account" "navigation navigation"', md: '"brand navigation account"' },
  }}>
    <Box component={Link} to="/" aria-label="City of Doncaster Council homepage" sx={{
      gridArea: 'brand', display: 'flex', alignItems: 'center', alignSelf: 'stretch',
      width: { xs: 190, md: 232 }, minHeight: { xs: 88, md: 104 },
      px: { xs: 2, md: 2.5 }, pr: { xs: 4, md: 5 }, bgcolor: '#505251',
      clipPath: 'polygon(0 0, 100% 0, calc(100% - 26px) 100%, 0 100%)',
      '&:focus-visible': { outline: '3px solid #fff', outlineOffset: '-5px' },
    }}>
      <Box component="img" src="/branding/doncaster-council.png" alt="City of Doncaster Council" width={537} height={214} sx={{ display: 'block', width: '100%', height: 'auto' }} />
    </Box>
    <Box component="nav" aria-label="Main navigation" sx={{
      gridArea: 'navigation', display: 'flex', alignItems: 'center',
      px: { xs: 2, md: 0 }, pb: { xs: 1.5, md: 0 }, gap: '1px',
      '& .MuiButton-root': {
        bgcolor: '#464646', color: '#fff', px: 2, minHeight: 48,
        borderRadius: 0, borderBottom: '4px solid transparent', pt: 1.5, pb: 1,
        fontSize: '0.82rem', whiteSpace: 'nowrap',
        '&.active': { bgcolor: '#505050', borderBottomColor: '#bcbcbc' },
        '&:hover': { bgcolor: '#575757' },
        '&:focus-visible': { outline: '2px solid #fff', outlineOffset: '-4px' },
      },
    }}>
      {user?.status === 'APPROVED' ? <>
        {modules.filter(module => module.routes.some(route => route.path === module.path && canAccess(user, route.capability))).map(module => <Button component={NavLink} key={module.id} to={module.path}>{module.label}</Button>)}
        {canAccess(user, 'users.manage') && <Button component={NavLink} to="/admin">Administration <Box component="span" sx={{ ml: 1, fontSize: 10 }}>▾</Box></Button>}
      </> : <Typography variant="body2" sx={{ px: 2, color: '#fff' }}>Account access</Typography>}
    </Box>
    <Stack direction="row" spacing={1.5} alignItems="center" sx={{ gridArea: 'account', px: { xs: 2, md: 3 }, py: 1.5 }}>
      {user && <>
        <Avatar sx={{ width: 30, height: 30, fontSize: 12, bgcolor: '#525252', color: '#fff' }}>{user.displayName.split(/\s+/).map(n => n[0]).slice(0, 2).join('')}</Avatar>
        <Typography variant="body2" sx={{ display: { xs: 'none', lg: 'block' }, color: '#fff', fontWeight: 600 }}>{user.displayName} · {user.role === 'ADMIN' ? 'Admin' : 'User'}</Typography>
      </>}
      {user && canSignOut && <Button size="small" sx={{ color: '#fff', whiteSpace: 'nowrap' }} onClick={onSignOut}>Sign out</Button>}
    </Stack>
  </Box>;
}

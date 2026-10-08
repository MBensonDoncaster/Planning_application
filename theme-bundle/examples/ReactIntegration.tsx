import type { ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { Avatar, Button, Container, CssBaseline, Stack, ThemeProvider, Typography } from '@mui/material';
import { AppHeader, theme } from '../src';

/** Render inside your EXISTING router. Pass account data from your existing app. */
export function ThemedApplication({ children, displayName, canAdminister, onSignOut }: {
  children: ReactNode;
  displayName: string;
  canAdminister: boolean;
  onSignOut: () => void;
}) {
  const navigate = useNavigate();
  return <ThemeProvider theme={theme}>
    <CssBaseline />
    <AppHeader
      onHomeClick={event => { event.preventDefault(); navigate('/'); }}
      navigation={<>
        <Button component={NavLink} to="/" end>Home</Button>
        {/* Replace this route with the administration route in your application. */}
        {canAdminister && <Button component={NavLink} to="/admin">Administration</Button>}
      </>}
      account={<>
        <Avatar sx={{ width: 30, height: 30, bgcolor: '#525252', fontSize: 12 }}>{displayName.split(/\s+/).map(n => n[0]).slice(0, 2).join('')}</Avatar>
        <Stack sx={{ display: { xs: 'none', lg: 'flex' } }}><Typography variant="body2" fontWeight={600}>{displayName}</Typography></Stack>
        <Button onClick={onSignOut}>Sign out</Button>
      </>}
    />
    <Container component="main" maxWidth={false} sx={{ px: { xs: 2, md: 2.5 }, py: 3.5 }}>{children}</Container>
  </ThemeProvider>;
}

import { Alert, Box, Button, Paper, Stack, Typography } from '@mui/material';
import type { User } from '../types';
import { PageBanner } from '../components/PageBanner';
import { ThemeIcon } from '../components/ThemeIcon';

export function AccessScreen({ user, refresh }: { user: User; refresh: () => void }) {
  const text = {
    PENDING: ['Awaiting administrator approval', 'Your account has been registered. An administrator needs to approve your access before you can continue.'],
    REJECTED: ['Access request declined', 'Contact your application administrator if you believe you should have access.'],
    DISABLED: ['Your account is disabled', 'Contact your application administrator to request access again.'],
    APPROVED: ['Access approved', 'Your account is ready.'],
  }[user.status];
  return <Box sx={{ maxWidth: 740, mx: 'auto', mt: { xs: 1, md: 5 } }}>
    <PageBanner title={text[0]} description="Application account access" kind="shield" />
    <Paper variant="outlined" sx={{ p: { xs: 3, md: 4 }, borderRadius: '0 0 12px 12px' }}>
    <Stack spacing={3}>
      <Typography color="text.secondary">{text[1]}</Typography>
      <Alert severity={user.status === 'PENDING' ? 'info' : 'warning'}>{user.displayName} · {user.email || 'Signed in with Microsoft'}</Alert>
      <Button variant="contained" startIcon={<ThemeIcon kind="refresh" />} onClick={refresh} sx={{ alignSelf: 'start' }}>Refresh access</Button>
    </Stack>
  </Paper></Box>;
}

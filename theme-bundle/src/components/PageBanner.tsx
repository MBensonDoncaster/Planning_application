import type { ReactNode } from 'react';
import { Box, Stack, Typography } from '@mui/material';
import { design } from '../theme';
import { ThemeIcon } from './ThemeIcon';

export function PageBanner({ title, description, kind = 'home', actions }: { title: string; description: string; kind?: 'home' | 'users' | 'shield'; actions?: ReactNode }) {
  return <Box sx={{ background: `linear-gradient(110deg, ${design.magenta}, ${design.plum})`, color: '#fff', p: { xs: 2.5, md: 3.5 }, borderRadius: 0 }}>
    <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} alignItems={{ xs: 'start', md: 'center' }}>
      <Stack direction="row" spacing={2.5} alignItems="center" sx={{ flexGrow: 1 }}>
        <ThemeIcon kind={kind} sx={{ fontSize: 36, color: '#ffcb77', flexShrink: 0 }} />
        <Box><Typography variant="h4" component="h1" sx={{ color: '#fff', mb: 0.75 }}>{title}</Typography><Typography variant="body2" sx={{ color: '#fff', fontSize: '0.8rem', lineHeight: 1.6 }}>{description}</Typography></Box>
      </Stack>
      {actions && <Box sx={{ flexShrink: 0, '& .MuiButton-root': { color: '#fff', borderColor: 'rgba(255,255,255,0.85)', fontSize: '0.75rem', '&:hover': { borderColor: '#fff', bgcolor: 'rgba(255,255,255,0.1)' } } }}>{actions}</Box>}
    </Stack>
  </Box>;
}

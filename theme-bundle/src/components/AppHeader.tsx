import type { MouseEventHandler, ReactNode } from 'react';
import { Box } from '@mui/material';
import { design } from '../theme';

export interface AppHeaderProps {
  navigation: ReactNode;
  account?: ReactNode;
  logoSrc?: string;
  brandLabel?: string;
  homeHref?: string;
  onHomeClick?: MouseEventHandler<HTMLAnchorElement>;
}

/** Presentation only. Supply navigation and account controls from the host app. */
export function AppHeader({
  navigation, account, logoSrc = '/branding/doncaster-council.png',
  brandLabel = 'City of Doncaster Council', homeHref = '/', onHomeClick,
}: AppHeaderProps) {
  return <Box component="header" sx={{
    bgcolor: '#333333', color: '#fff', borderBottom: `3px solid ${design.teal}`,
    display: 'grid', alignItems: 'center',
    gridTemplateColumns: { xs: 'minmax(0, 1fr) auto', md: '232px minmax(0, 1fr) auto' },
    gridTemplateAreas: { xs: '"brand account" "navigation navigation"', md: '"brand navigation account"' },
  }}>
    <Box component="a" href={homeHref} onClick={onHomeClick} aria-label={`${brandLabel} homepage`} sx={{
      gridArea: 'brand', display: 'flex', alignItems: 'center', alignSelf: 'stretch',
      width: { xs: 190, md: 232 }, maxWidth: '100%', minHeight: { xs: 88, md: 104 },
      px: { xs: 2, md: 2.5 }, pr: { xs: 4, md: 5 }, bgcolor: '#505251',
      clipPath: 'polygon(0 0, 100% 0, calc(100% - 26px) 100%, 0 100%)',
      '&:focus-visible': { outline: '3px solid #fff', outlineOffset: '-5px' },
    }}>
      <Box component="img" src={logoSrc} alt={brandLabel} width={537} height={214} sx={{ display: 'block', width: '100%', height: 'auto' }} />
    </Box>
    <Box component="nav" aria-label="Main navigation" sx={{
      gridArea: 'navigation', display: 'flex', alignItems: 'center', minWidth: 0, overflowX: 'auto',
      px: { xs: 2, md: 0 }, pb: { xs: 1.5, md: 0 }, gap: '1px',
      '& .MuiButton-root, & > a': {
        bgcolor: '#464646', color: '#fff', px: 2, minHeight: 48, flexShrink: 0,
        display: 'inline-flex', alignItems: 'center', textDecoration: 'none', fontWeight: 600,
        borderRadius: 0, borderBottom: '4px solid transparent', pt: 1.5, pb: 1,
        fontSize: '0.82rem', whiteSpace: 'nowrap',
        '&.active, &[aria-current="page"]': { bgcolor: '#505050', borderBottomColor: '#bcbcbc' },
        '&:hover': { bgcolor: '#575757' },
        '&:focus-visible': { outline: '2px solid #fff', outlineOffset: '-4px' },
      },
    }}>{navigation}</Box>
    <Box sx={{ gridArea: 'account', display: 'flex', alignItems: 'center', gap: 1.5, px: { xs: 2, md: 3 }, py: 1.5, '& .MuiButton-root': { color: '#fff', whiteSpace: 'nowrap' } }}>{account}</Box>
  </Box>;
}

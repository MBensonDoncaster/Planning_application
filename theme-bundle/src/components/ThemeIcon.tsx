import { SvgIcon, type SvgIconProps } from '@mui/material';

export function ThemeIcon({ kind = 'home', ...props }: SvgIconProps & { kind?: 'home' | 'users' | 'shield' | 'refresh' | 'arrow' }) {
  const paths = {
    home: <><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" /><path d="M9 21v-8h6v8" /></>,
    users: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 4v2" /></>,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" /><path d="m8 12 3 3 5-6" /></>,
    refresh: <><path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5" /></>,
    arrow: <><path d="M4 12h16m-6-6 6 6-6 6" /></>,
  };
  return <SvgIcon {...props} viewBox="0 0 24 24" sx={{ fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', ...props.sx }}>{paths[kind]}</SvgIcon>;
}

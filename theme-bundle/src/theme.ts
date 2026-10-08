import { createTheme } from '@mui/material';

// Shared design tokens based on the supplied dashboard reference.
export const design = {
  charcoal: '#2c2c2c', navigation: '#383838', subnavigation: '#484848',
  magenta: '#981b69', plum: '#6e124e', teal: '#008b84', canvas: '#f4f1eb',
};

export const theme = createTheme({
  palette: {
    primary: { main: design.magenta, dark: design.plum, contrastText: '#ffffff' },
    secondary: { main: design.teal },
    background: { default: design.canvas, paper: '#ffffff' },
    text: { primary: '#243746', secondary: '#697582' },
    divider: '#ede9e4',
    success: { main: '#008d5b' }, warning: { main: '#c47d0a' }, error: { main: '#d32f4b' },
  },
  typography: {
    fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 14,
    h3: { fontSize: '1.8rem', fontWeight: 700 }, h4: { fontSize: '1.5rem', fontWeight: 700 },
    h6: { fontSize: '1rem', fontWeight: 700 },
    subtitle2: { fontWeight: 700 },
    button: { fontWeight: 600, textTransform: 'none' },
    overline: { fontSize: '0.72rem', letterSpacing: '0.04em' },
  },
  shape: { borderRadius: 12 },
  components: {
    MuiCssBaseline: { styleOverrides: { body: { minWidth: 320 }, '#root': { minHeight: '100vh' } } },
    MuiPaper: { styleOverrides: {
      root: { backgroundImage: 'none' },
      outlined: { border: 'none', boxShadow: '0 3px 14px rgba(35, 28, 21, 0.055)' },
    } },
    MuiButton: { defaultProps: { disableElevation: true }, styleOverrides: {
      root: { borderRadius: 4, minHeight: 34 },
      outlined: { borderColor: '#d9ccd3' },
    } },
    MuiTextField: { defaultProps: { size: 'small' } },
    MuiOutlinedInput: { styleOverrides: { root: { borderRadius: 6, backgroundColor: '#ffffff' } } },
    MuiTableCell: { styleOverrides: {
      head: { backgroundColor: '#faf8f5', color: '#33404c', fontWeight: 700, fontSize: '0.78rem' },
      root: { padding: '16px 20px', borderBottomColor: '#ede9e4' },
    } },
    MuiTableRow: { styleOverrides: { root: { '&:last-child td': { borderBottom: 0 } } } },
    MuiChip: { styleOverrides: { root: { fontWeight: 700, fontSize: '0.68rem', borderRadius: 5 } } },
    MuiAlert: { styleOverrides: { root: { borderRadius: 6, fontSize: '0.8rem' } } },
    MuiDialogTitle: { styleOverrides: { root: { background: design.charcoal, color: '#ffffff', borderBottom: `3px solid ${design.teal}` } } },
    MuiDialogContent: { styleOverrides: { root: { paddingTop: '24px !important' } } },
  },
});

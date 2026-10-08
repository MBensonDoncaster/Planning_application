# City of Doncaster application theme

A portable visual bundle extracted from the completed template. It includes the council logo, the angled charcoal header with adjacent navigation, teal divider, magenta page banners, warm background, card styling, inputs, tables and dialogs.

Choose the React/Material UI integration or the framework-neutral CSS version. Both reuse your existing application content. This bundle contains presentation code only; supply your current navigation, account controls and permission decisions.

## Contents

```text
src/theme.ts                 Material UI theme and colour tokens
src/components/AppHeader.tsx Configurable header; no app-specific user model or routes
src/components/PageBanner.tsx
src/components/ThemeIcon.tsx
src/index.ts                 Component exports
public/branding/doncaster-council.png
theme.css                    Scoped CSS for other frameworks
examples/ReactIntegration.tsx
examples/preview.html        Open directly for an offline visual preview
previews/desktop.png         Screenshot from the running template
previews/mobile.png
package.json                 Compatibility metadata; this is a copy-in bundle
```

## React and Material UI

The source is TypeScript/TSX, intended to be copied into an existing frontend and compiled by that application's toolchain. It is not a prebuilt npm library. Tested in React 19, Material UI 7 and Emotion 11; peer metadata also permits React 18. The core components do not require a router. The integration example uses React Router's `NavLink` and `useNavigate`.

1. Copy `src/` into your application as `src/ui/council-theme/`.
2. Copy the logo to your application's `public/branding/doncaster-council.png` (or the equivalent public asset directory).
3. If the application does not already use Material UI, install compatible packages:

   ```sh
   npm install @mui/material@7 @emotion/react@11 @emotion/styled@11
   ```

4. Wrap the existing application shell with `ThemeProvider` and `CssBaseline`:

   ```tsx
   import { CssBaseline, ThemeProvider } from '@mui/material';
   import { theme } from './ui/council-theme';

   <ThemeProvider theme={theme}>
     <CssBaseline />
     <ExistingApplication />
   </ThemeProvider>
   ```

   Keep your existing router and providers. For an application that already has a customised MUI theme, you can merge rather than replace it: `createTheme(existingTheme, theme)`. Review overlapping component overrides to keep custom behaviour you need. Colours, typography and MUI outlined-paper styles intentionally change globally inside the provider; plain CSS and hard-coded `sx` colours may still need updating on your existing pages.

5. Replace the existing header with `AppHeader`. Pass your current navigation into `navigation` and your current profile/sign-out controls into `account`. Navigation permissions remain the host application's responsibility. `examples/ReactIntegration.tsx` demonstrates this; adjust imports and route URLs after copying it. Render it inside your existing router rather than adding a second router.
6. Add `PageBanner` to page headings and use MUI `Paper variant="outlined"` for the white cards:

   ```tsx
   import { Paper, Stack, Typography } from '@mui/material';
   import { PageBanner, design } from './ui/council-theme';

   <Stack spacing={3}>
     <PageBanner title="Your page title" description="Your existing page description" />
     <Paper variant="outlined" sx={{ p: 3, borderLeft: `4px solid ${design.magenta}` }}>
       <Typography variant="h6" color="primary">Your section title</Typography>
       {/* Existing content */}
     </Paper>
   </Stack>
   ```

`AppHeader` accepts `navigation` (required), `account`, `logoSrc`, `brandLabel`, `homeHref` and `onHomeClick`. The defaults use the included council logo and `/` as the homepage. For SPA navigation, use the example's `onHomeClick` handler or your router's equivalent. For an application hosted under a subpath, supply its actual logo URL and homepage URL; root-relative defaults may otherwise point outside that application.

Keep the account area compact on smaller screens, as shown in the example. At widths below 900px navigation moves beneath the logo within the same header. Longer menus scroll horizontally. Active navigation can use either an `active` class or `aria-current="page"`.

## Other frameworks or plain HTML

1. Copy `theme.css` and `public/branding/doncaster-council.png` to your application assets.
2. Include the stylesheet and apply `dc-theme` to the body or a wrapper around your application.
3. Use the header/banner/card markup from `examples/preview.html`, replacing the preview navigation and content with your current routes and controls.
4. Update image/stylesheet paths for the destination application. Use `aria-current="page"` on the current navigation link.

The CSS selectors are scoped to `dc-*` classes. It does not automatically restyle every existing component; add the classes to the corresponding layout elements. `examples/preview.html` can be opened from disk without a build or internet connection.

## Rebranding and validation

Colour tokens live in `src/theme.ts` and CSS variables at the top of `theme.css`. Replace the logo, `brandLabel` and home-link settings if applying different branding. The React header also contains the original reference's grey header-panel shades; the equivalent shades are in `theme.css`.

After integration, check desktop/mobile layout, logo loading, keyboard focus, active navigation, dialogs, tables, sign-in/out and permission-specific menu visibility. Keep the destination application's existing server-side authorization checks.

The included logo is the original council asset, served locally after copying:
[City of Doncaster Council logo](https://www.doncaster.gov.uk/Themes/DMBC.Theme2/Content/images/template/logo.png).

The bundle and offline preview were checked using the template's existing TypeScript, Material UI and browser tooling. Live screenshots show the template; they are examples rather than additional screens you must implement.

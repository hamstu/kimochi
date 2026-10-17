# Kimochi website

The marketing site for Kimochi: a static Vite 7 + React 19 + TypeScript + Tailwind 4 single-page
app with client-side routes (`react-router`, `BrowserRouter`). The marketing pages make one
network call, to the public GitHub API, to find the latest release. The account pages (`/account`,
`/link`) call the Kimochi server's `/api` on the same origin (see "Account pages").

## Run

```sh
npm install --prefix site     # once
npm run site:dev              # http://127.0.0.1:1450 (from the repo root)
npm run site:build            # demo:build (the real Log, into public/demo/) then static output in site/dist
npm run site:preview          # serve site/dist at http://127.0.0.1:1451
npm --prefix site test        # node --test site/test/*.test.mjs
npm --prefix site run typecheck
```

Hosting: serve `site/dist` from the domain root and rewrite unknown paths to `/index.html` (SPA
fallback) so `/privacy`, `/terms` and `/compare` load on a hard refresh. Root `eslint` ignores
`site/**`; the site has its own `tsconfig.json` (strict, `noUnusedLocals`, `checkJs`).

## Layout

```
site/
  index.html              title, meta description, Open Graph, theme-color, pre-paint theme script
  public/                 favicon.svg (placeholder; copy branding/icon.svg here), robots.txt
  src/
    main.tsx              BrowserRouter + App
    App.tsx               routes + per-route document titles (TITLES map)
    pages/                one component per route: Home, Privacy, Terms, Compare, NotFound,
                          Account*, LinkApp (see "Account pages")
    components/           Layout, Section, Prose, Button, DownloadButton, ThemeToggle,
                          AccountNavLink; account/ (forms, meters, dashboard sections)
    demo/                 the interactive demo (LiveDemo.tsx; see "Demo" below)
    lib/                  theme.ts, releases.ts (fetch + detection), assets.js (pure picker),
                          api.ts (account API client), session.tsx (useSession), account.js (pure)
    styles/               tokens.css (colour roles, light/dark), index.css (Tailwind + @theme)
    assets/               images imported by components (import url from '../assets/x.png')
  test/                   node --test files (*.test.mjs)
```

## Conventions

**Pages.** A route is a component in `src/pages/<Name>.tsx`, exported by name
(`export function Privacy()`), registered in `App.tsx` and given a title in `TITLES`. Pages render
inside `Layout` (sticky header, footer); they never render their own header or footer.

**Home sections** use `<Section>` so vertical rhythm stays consistent:

```tsx
<Section id="features" eyebrow="Features" heading="…" lede="…" divider>…</Section>
```

Props: `id?`, `eyebrow?`, `heading?` (h2), `lede?`, `align?: 'start' | 'center'`,
`width?: 'narrow' | 'default' | 'wide'`, `tone?: 'ground' | 'bar'` (bar = quiet slate-2 band with
hairlines), `divider?` (hairline on top), `className?`, `children`. The header nav links to the
ids `features`, `demo` and `download` on `/`, so keep those ids. Only the home hero uses an h1
(`text-display`).

**Long-form pages** (privacy, terms, compare) use `<Prose title lede? updated?>` and plain
semantic HTML inside (h2, h3, p, ul, ol, table, blockquote, a, code); `.prose-k` in `index.css`
styles them at ~65ch. Tables scroll horizontally on narrow screens.

**Buttons.** `<Button variant="primary|secondary" size="md|lg" icon={<Icon size={16} aria-hidden />}
href? …>`. With `href`, internal paths (`/compare`, `/#demo`) render a router `Link`; other URLs an
`<a>`; without `href` it is a `<button type="button">`. One primary button per surface (the app's
One Voice rule: indigo means primary action, current, checked or focus, nothing else).
`buttonClass(variant, size, extra)` gives the same classes for custom elements.

**Tokens and Tailwind names.** Never use hex values or `dark:` / `prefers-color-scheme` in
components; use the roles, which already switch with the theme.

| Tailwind | CSS var | Use |
| --- | --- | --- |
| `bg-ground` | `--k-bg` | page ground |
| `bg-bar` | `--k-bar` | header, footer, quiet bands |
| `bg-sunken` | `--k-sunken` | wells: previews, code, empty frames |
| `bg-raised` / `shadow-pop` | `--k-raised` | popovers, floating panels |
| `bg-field` | `--k-field` | secondary buttons, inputs |
| `text-ink` / `text-ink-2` / `text-ink-3` | `--k-text*` | primary / secondary / meta text |
| `border-hairline` / `divide-hairline` | `--k-line` | every divider |
| `border-line-strong` | `--k-line-strong` | control borders |
| `bg-hover` / `bg-press` | `--k-hover` / `--k-press` | neutral hover and selected washes |
| `bg-accent` / `hover:bg-accent-hover` / `text-accent-contrast` | `--k-accent*` | the indigo fill |
| `text-accent-ink` | `--k-accent-text` | indigo as text, icons, links (#3a5bc7 / #9eb1ff) |
| `bg-accent-soft` | `--k-accent-soft` | indigo wash |
| `outline-focus` | `--k-focus` | focus ring (global `:focus-visible` already set) |
| `text-danger` / `text-ok` / `text-warn` | status text | |
| `shadow-frame` | `--k-shadow-frame` | the one big screenshot / demo frame |

Note `text-accent` exists but is the fill colour (#3e63dd), which is too dim on the dark ground:
use `text-accent-ink` for accent text.

Type: `font-sans` (Figtree Variable, the default), `font-jp` (Hiragino Sans, Noto Sans JP
Variable…; also applied automatically to any `lang="ja"` element or `.jp` class), `font-mono`.
Weights are the app's off-grid variable ones: `font-normal` 430, `font-medium` 520,
`font-semibold` 620. Sizes: `text-display` (hero h1, fluid), `text-title` (section h2, fluid),
`text-heading` (h3, 18px), `text-lede` (intro paragraphs), `text-body` (16px), `text-small`
(14px), `text-meta` (12px, medium). Headings get `text-wrap: balance` globally; add `tnum` to any
number (versions, sizes, counts, dates). Radii `rounded-sm|md|lg|xl` are the app's 4/6/8/12px.
Widths: `container-page` utility (max 72rem, 16px gutters on phones, 24px from 640px),
`max-w-prose` (65ch). Mark Japanese text with `lang="ja"`.

**Theme.** `useTheme()` in `src/lib/theme.ts` returns `[choice, setChoice]` with
`'system' | 'light' | 'dark'`, stored in localStorage key `kimochi-site-theme` (try/catch), and
sets `data-theme` on `<html>`. `index.html` applies it before first paint.

**Images** go in `src/assets/` and are imported (Vite fingerprints them). Only files that need a
fixed URL (favicon, robots.txt, a future `og.png`) go in `public/`. Give images explicit `width`
/ `height`, `alt`, and `loading="lazy"` below the fold.

**Downloads.** `<DownloadButton align?="start|center" showAll?={true} className? />` fetches
`https://api.github.com/repos/hamstu/kimochi-tauri/releases/latest` (unauthenticated, cached in
sessionStorage for 10 minutes); when that 404s (no tagged release published yet) it falls back to
`releases/tags/nightly`, the rolling pre-release CI refreshes on every push to main, and labels it
"Development build" with its date. It detects the OS and CPU (User-Agent Client Hints
`getHighEntropyValues(['architecture', 'bitness'])` in Chromium, else user-agent heuristics;
Safari on a Mac is assumed Apple silicon), and picks an installer with `pickAsset(assets,
platform)` from `src/lib/assets.js`. Asset names are tauri's (`Kimochi_<ver>_aarch64.app.zip`,
`Kimochi_<ver>_x64-setup.exe`, `kimochi_<ver>_amd64.deb`, `kimochi_<ver>_aarch64.AppImage`, …;
the nightly drops `_<ver>`; an `-arch` suffix before the extension marks the Arch Linux build).
Preference: macOS `.dmg` then `.app.zip`; Windows `-setup.exe` then `.msi`; Linux `.AppImage`
then `.deb` then `.rpm`, with every generic build before the `-arch` one. It shows the version
(or "Development build"), platform and size, plus an "Other platforms" disclosure. On a rate
limit, network error, no published build, a phone, or no build for the platform, it links to
https://github.com/hamstu/kimochi-tauri/releases instead. The API only answers for a public
repository; drafts are invisible to it.

## Demo

`<LiveDemo />` (`src/demo/`) plays a synthetic visual novel (`GameScreen`, `SceneArt`: original
CSS/SVG art) with Kimochi's overlay over it: line → scan sweep → word boxes → dictionary popup →
next. Visitors can hover or tap any boxed word. A platform switcher (macOS · Windows · Linux ·
Steam Deck) restyles the stage; Steam Deck replays the controller flow (both sticks → radial menu
→ Scan → D-pad word to word → A reads → B back), redrawn from the app's `ui/radial-menu.js`.

Beside the game sits the **real Log window**: the app's React UI from the preview harness
(`frontend/dev/`, Tauri runtime mocked), built by `npm run demo:build` (root
`vite.demo.config.ts`) into `site/public/demo/` (gitignored) and embedded as
`/demo/panel.html?window=log&embed=1&sidebar=0&theme=…&platform=…`. The demo posts each line to
it (`postMessage`, handled by `?embed=1` in `frontend/dev/preview-setup.ts`) so it arrives in the
Log as an OCR scan would. The iframe is `inert` and `pointer-events: none` until the visitor
presses "Try it". Without the build (plain `site:dev`) the Log pane says to run `npm run demo:build`.

**The example game** is `frontend/dev/demo-content.ts`, shared with the preview harness: lines
(the ones marked `play` are shown in the game, pre-split into `tokens`), a tiny `vocab`
dictionary, and the scene palette. To swap the game, edit only that file, then rerun
`npm run demo:build`. The site imports it as `@kimochi/demo-content` (alias in `vite.config.ts`,
`paths` in `tsconfig.json`, and `server.fs.allow` so the dev server may serve that one file from
outside `site/`).

The run pauses offscreen and in hidden tabs; with `prefers-reduced-motion` it shows one still
frame with the popup open. The game screen sizes everything in container units (`demo.css`), so it
scales as one picture; at phone width the panes stack and the game stays 16:10.

## Account pages

Optional Kimochi accounts (cloud OCR, read aloud, translation, explanations, backup). The API
contract is `kimochi-server/API.md` (a sibling repo); the server is a Cloudflare Worker that in
production serves **both** this site (`site/dist`, Workers Static Assets with SPA fallback) and
`/api/*` on one origin. So the site calls relative `/api/...` URLs with
`credentials: 'same-origin'`, and the web session is a first-party HttpOnly cookie the pages never
read. State-changing requests carry the browser's `Origin`, which the server checks against its
`PUBLIC_URL`.

| Route | Page | What it does |
| --- | --- | --- |
| `/account` | `Account.tsx` | Dashboard (redirects to sign-in when signed out): profile, plan and monthly usage meters, linked Kimochi apps (sign out each), sign-in methods (password, Google, Discord), backup (storage, sessions, delete all), delete account, sign out. Sections live in `components/account/sections.tsx`. |
| `/account/sign-in` | `AccountSignIn.tsx` | Email + password, Continue with Google/Discord, links to sign-up and forgot. Honours `?returnTo=` (same-origin paths only, via `safeReturnTo`) and shows OAuth `?error=` codes in plain language. |
| `/account/sign-up` | `AccountSignUp.tsx` | Name (optional), email, password (10–200 chars). |
| `/account/forgot` | `AccountForgot.tsx` | Sends a reset link (always reports success, as the API does). |
| `/account/reset?token=` | `AccountReset.tsx` | Choose a new password; signs in and ends other sessions. |
| `/account/verify?token=` | `AccountVerify.tsx` | Confirms the email on load (single-use token, guarded against StrictMode's double effect). |
| `/link?code=` | `LinkApp.tsx` | The app's device-link confirmation: signs in first if needed (returning here), shows the code large with the device name and platform, Approve / Deny, then "Open Kimochi" (`kimochi://account`). Expired or unknown codes, and arriving without a code, show a code entry form. |

- **`src/lib/api.ts`**: the typed client (`api.signIn(…)`, `api.usage()`, …) and types (`User`,
  `Usage`, `Device`, `Backup`, `LinkRequest`). Failures throw `ApiError { status, code, message }`
  from the server's `{ error, message }`; no server at all (network error, or a non-JSON 404/5xx)
  becomes code `network`. OAuth starts are full-page links: `oauthStartUrl(provider, returnTo)`.
- **`src/lib/session.tsx`**: `<SessionProvider>` (wraps the routes in `App.tsx`) loads
  `GET /api/auth/me` once; `useSession()` gives `{ status: 'loading' | 'signed-in' | 'signed-out',
  user, unreachable, refresh, setUser }`. The header's `AccountNavLink` reads it ("Account" /
  "Sign in").
- **`src/lib/account.js`**: pure, tested helpers (`test/account.test.mjs`): `safeReturnTo`,
  `normalizeLinkCode` (`abcd efgh` → `ABCD-EFGH`), `formatCodeInput`, `messageForCode` (API and
  OAuth error codes → sentences), `formatStorage`, `usageFraction`, `resetDay`/`formatResetDay`,
  `relativeTime`, `platformLabel`, `planLabel`, `deleteConfirmMatches`. Plan limits are never
  hard-coded: meters use what `GET /api/v1/usage` and `GET /api/account/backup` return.
- **UI pieces** in `components/account/`: `AuthShell` (narrow page that focuses its h1 after
  navigation), `Field` (label, hint, inline error, `aria-describedby`), `Notice` (tinted callout),
  `SubmitButton` (disabled + `aria-busy` + spinner), `Meter`, `OAuthButtons`, and `parts.tsx`
  (`AccountSection`, `Badge`, `ConfirmButton`). The one primary button per surface is the form's
  submit on auth pages and Approve on `/link`; the dashboard uses secondary buttons only, with
  danger text for destructive ones.

**Run against a local server.** In `kimochi-server`, start `wrangler dev` on
`http://127.0.0.1:3000` with `PUBLIC_URL=http://127.0.0.1:1450` in `.dev.vars`. Then
`npm run site:dev`: Vite proxies `/api` to port 3000 (`server.proxy` in `vite.config.ts`, also
for `site:preview`) **without** `changeOrigin`, so `Host` and `Origin` stay `127.0.0.1:1450`, the
Origin check passes, and cookies and OAuth redirects stay on the site's origin. Emails are not
sent in development; read the links from `GET /api/dev/outbox`. Without the server the account
pages say they cannot reach it, and the marketing pages work as before.

## What other agents must know

- Only edit inside `site/`. Do not edit `src/components/Layout.tsx`, `src/styles/*` or
  `src/lib/*` without a reason; add new shared pieces as new files in `src/components/`.
- Home page: fill `src/pages/Home.tsx` with `<Section>`s; keep the ids `features`, `demo`,
  `download`, keep `<LiveDemo />` inside `#demo` and a `<DownloadButton />` inside `#download`.
- Demo: replace `src/demo/LiveDemo.tsx`, keeping `export function LiveDemo(props)` with all props
  optional. It should fill its container's width (16:10 on desktop; it may grow taller on phones)
  and must not cause horizontal scroll at 360px. Put demo images in `src/assets/` or
  `src/demo/`.
- Privacy / Terms / Compare: replace the placeholder body inside `<Prose>`; keep the exported
  component name. Use `updated="YYYY-MM-DD"` on Privacy and Terms.
- Favicon: copy `branding/icon.svg` to `site/public/favicon.svg` (the header wordmark uses it).
- Verify with `npm --prefix site run typecheck && npm --prefix site test && npm --prefix site run build`.

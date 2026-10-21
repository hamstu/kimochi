# SEO and launch TODOs for Hamish

Everything here needs a decision or a fact only Hamish has. Each item is also marked in the code:
`grep -rn "TODO(hamish)" site --exclude-dir=node_modules --exclude-dir=dist`. FAQ items with a
`todo` field show it on the page in the dev server only (dashed box), never in the build.

## Launch blockers

1. **The GitHub repo is private.** `github.com/hamstu/kimochi-tauri` returns 404 to visitors, so
   every Download button, "Release notes", "Source on GitHub", "Open an issue" link and the Linux
   installer (`curl … /install.sh | sh`) fail for the public. The download button's GitHub API
   calls fail too.
   - Code: `src/lib/releases.ts` (REPO), `src/components/Layout.tsx` (GITHUB_URL),
     `src/content/compare.ts` (Kimochi's URL and source), `src/pages/Compare.tsx`,
     `src/pages/Privacy.tsx`, `src/pages/Terms.tsx`, `public/install.sh`, FAQ `open-source` and
     `feedback`.
   - Either make the repo public, or change these links.
2. **The Download CTA has no fallback.** No email capture was built: choose a service first, then
   replace the hero and `#download` buttons with launch sign-up (`src/components/home/Hero.tsx`,
   `src/pages/Home.tsx`).
## Facts to settle (they show up in AI answers)

3. **Currency.** The site shows "$"; JSON-LD says USD (`src/lib/seo.js`, PRICE_CURRENCY).
4. **Free allowance vs trial.** The privacy page says an account adds hosted services "within free
   monthly allowances"; the pricing shows only a 14-day trial (FAQ `price`).
5. **macOS minimum and Intel Macs.** Home says "Apple silicon", /compare says "macOS 14+". Also:
   which Linux distros, and the minimum Windows version (OneOCR needs Windows 11) (FAQ `platforms`).
6. **Release status.** Target release window (or "no date yet"), how to get notified, whether the
    nightly builds are public (FAQ `release`).
7. **Who it's for.** Beginners who can't read kana yet, or intermediate learners? (FAQ `who-is-it-for`)
8. **Texthookers.** Which ones are tested (Textractor, LunaTranslator, Agent…)? (FAQ
    `anki-and-texthookers`)
9. **Phones, tablets, other languages.** Planned or out of scope? (FAQ `mobile-and-languages`)
10. **Feedback channels.** Email is hamstu@gmail.com; add GitHub discussions or Discord if you start them (FAQ `feedback`).

## Nice to have

11. **Social card.** A 1200×630 `og:image` (screenshot plus wordmark). The pages use the 512×512
    app icon with `summary_large_image` for now (`src/lib/seo.js`, OG_IMAGE).
12. **`sameAs` links** for the Person and SoftwareApplication JSON-LD: public GitHub, Discord,
    YouTube, Bluesky/X once they exist; `downloadUrl` once the repo is public (`src/lib/seo.js`).
13. **HSTS and "Always Use HTTPS"** in Cloudflare (from the audit; not set from this repo).

## How to check

```sh
npm --prefix site run build             # client + SSR build, then scripts/prerender.mjs
npm --prefix site run check:prerender   # every route: own title, description, canonical/noindex, JSON-LD, static content
npm --prefix site run preview           # http://127.0.0.1:1451; unknown paths answer 404 (as in production,
                                        # where kimochi-server serves dist/ with not_found_handling = "404-page")
curl -sI http://127.0.0.1:1451/nope     # HTTP/1.1 404
curl -s http://127.0.0.1:1451/faq | grep -o '<script type="application/ld+json">.\{0,120\}'
```

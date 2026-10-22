# SEO and launch TODOs for Hamish

Everything here needs a decision or a fact only Hamish has. Each item is also marked in the code:
`grep -rn "TODO(hamish)" site --exclude-dir=node_modules --exclude-dir=dist`. FAQ items with a
`todo` field show it on the page in the dev server only (dashed box), never in the build.

## Open

Nothing open. All questions were answered on 2026-10-22; what is left for after launch (more
`sameAs` links, Discord, Search Console) is on the maintainer's post-launch checklist.

## How to check

```sh
npm --prefix site run build             # client + SSR build, then scripts/prerender.mjs
npm --prefix site run check:prerender   # every route: own title, description, canonical/noindex, JSON-LD, static content
npm --prefix site run preview           # http://127.0.0.1:1451; unknown paths answer 404 (as in production,
                                        # where kimochi-server serves dist/ with not_found_handling = "404-page")
curl -sI http://127.0.0.1:1451/nope     # HTTP/1.1 404
curl -s http://127.0.0.1:1451/faq | grep -o '<script type="application/ld+json">.\{0,120\}'
```

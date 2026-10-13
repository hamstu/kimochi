# Kimochi (Tauri) — notes for agents

- **Workflow**: `main` is the dev line (every push refreshes the `nightly` pre-release). Releases
  happen only through `npm run release -- <x.y.z>` on a clean `main`; CI builds, signs and
  publishes on its own. Read `RELEASING.md` (maintainer's local copy) or CONTRIBUTING.md's
  Releases paragraph before touching versions, tags, `CHANGELOG.md` or
  `.github/workflows/ci.yml`. Never bump the version or tag by hand.
- **Changelog**: a user-visible change gets a `- ` line under `## [Unreleased]` in `CHANGELOG.md`,
  written for the app's users (it becomes the release notes and the in-app "What's new").
- **Checks before merging**: `npm test`, `npm run typecheck`, `npm run lint`, `npm run check:rust`
  (see [CONTRIBUTING.md](CONTRIBUTING.md)).
- **Contracts**: native commands and events are documented in [COMMANDS.md](COMMANDS.md); every
  `invoke('…')` literal must be a registered command (`scripts/command-contract.test.mjs`).
  UI uses the kit ([frontend/kit/README.md](frontend/kit/README.md)) and the tokens in
  [DESIGN.md](DESIGN.md). Browser preview of every window: `npm run preview:ui`.
- **Private notes stay local**: `docs/`, `evidence/` and every root `.md` not allowlisted in
  `.gitignore` exist only on the maintainer's machine and are never committed. Write plans,
  handoffs, bring-up reports and research there; anything the public needs goes in README.md or
  CONTRIBUTING.md.

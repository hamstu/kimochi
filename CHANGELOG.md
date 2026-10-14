# Changelog

What changed in each release of Kimochi, newest first. Written for the people who use the app:
what they can now do, what behaves differently, what was fixed. The app shows this file in
**What's new** (and once, on its own, after it has updated), and the version's section becomes
the GitHub release's notes, so keep it readable.

Add lines under **Unreleased** as you merge work; `npm run release -- <version>` moves them under
the new version with the date. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Headings inside a version are optional: `### Added`, `### Changed`, `### Fixed`, `### Removed`.

## [Unreleased]

### Added

- Google Lens is a new OCR engine, and the default for new installs: accurate on Japanese,
  horizontal or vertical, with nothing to download. It sends each capture to Google, so choose a
  local engine in Settings → OCR & Overlay if you'd rather nothing leave your computer. Existing
  installs keep the engine they use.

- Kimochi updates itself. A bundle checks GitHub Releases quietly after launch and every six
  hours; a found update appears above Settings in the sidebar, where you download it and choose
  when to restart. Settings → General → Updates checks on demand and shows the version.
- A guided setup for the Yomitan API, the dictionary option that looks words up through the
  Yomitan already in your browser. Kimochi finds the helper your browser needs (its own or the
  official one), installs its own in one click if you have none, shows how to turn the API on in
  Yomitan, and tells you the moment it connects. It appears in the first-run guide and in
  Settings → Dictionary.
- Choosing a dictionary (Settings → Dictionary, and the first-run guide) shows a picture of each
  engine's pop-up looking up a word in game dialogue; click it to see it full size.

### Changed

- The dictionary options have clearer names: **Built-in Yomitan** (a copy of Yomitan inside
  Kimochi, set up with its own or your exported dictionaries) and **Yomitan API** (formerly
  "Kimochi pop-up"). Your choice is kept.

### Fixed

- The Yomitan API helper now installs correctly on Windows, for every supported browser.
- The Built-in Yomitan pop-up over the Log no longer has a white border in dark mode: its frame
  now matches the pop-up's own theme, light or dark.

### Removed

- Text to speech (read aloud) and Kimochi's own Cloud OCR are unavailable in public builds for
  now. If Cloud OCR is your selected engine, scans say it needs an access key: choose another
  engine in Settings → OCR & Overlay. The OwOCR (WebSocket OCR) engine has been removed; if it
  was selected, Kimochi uses the default engine instead.
- Auto-scan is now started from your controller (the gamepad trigger in Settings → OCR &
  Overlay) or a scan shortcut; the keyboard "Trigger keys" option is gone on every platform.
  On macOS, Kimochi no longer needs Accessibility permission, and you can remove it in System
  Settings → Privacy & Security → Accessibility.

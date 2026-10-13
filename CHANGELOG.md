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

- Kimochi updates itself. A bundle checks GitHub Releases quietly after launch and every six
  hours; a found update appears above Settings in the sidebar, where you download it and choose
  when to restart. Settings → General → Updates checks on demand and shows the version.

### Removed

- Text to speech (read aloud) and Kimochi's own Cloud OCR are unavailable in public builds for
  now. If Cloud OCR is your selected engine, scans say it needs an access key: choose another
  engine in Settings → OCR & Overlay. The OwOCR (WebSocket OCR) engine has been removed; if it
  was selected, Kimochi uses the default engine instead.
- Auto-scan is now started from your controller (the gamepad trigger in Settings → OCR &
  Overlay) or a scan shortcut; the keyboard "Trigger keys" option is gone on every platform.
  On macOS, Kimochi no longer needs Accessibility permission, and you can remove it in System
  Settings → Privacy & Security → Accessibility.

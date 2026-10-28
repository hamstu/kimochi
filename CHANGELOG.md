# Changelog

What changed in each release of Kimochi, newest first. Written for the people who use the app:
what they can now do, what behaves differently, what was fixed. The app shows this file in
**What's new** (and once, on its own, after it has updated), and the version's section becomes
the GitHub release's notes, so keep it readable.

Add lines under **Unreleased** as you merge work; `npm run release -- <version>` moves them under
the new version with the date. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Headings inside a version are optional: `### Added`, `### Changed`, `### Fixed`, `### Removed`.

## [Unreleased]

- Steam Deck: the back buttons (L4, R4, L5, R5) and trackpad clicks can be bound in Settings → Shortcuts & Controls, and the controller menu now opens with R4 by default, so both sticks stay with your game.
- Steam Deck: setting a crop area works in Gaming Mode. Draw, move and resize the box with your finger, or move its corners with the sticks, then press A to save or B to cancel. Before, the editor could not be used or closed there.
- Fixed: Kimochi's own windows (the main window, Settings, the welcome guide) can be screenshotted and screen-recorded again, with Snipping Tool, ShareX or anything else. Only the OCR overlay and dictionary pop-ups stay hidden from captures.
- Fixed: sentence audio recording on Linux AppImages (including Steam Deck), which stopped with a PipeWire error as soon as it started.

## [0.2.0] - 2026-10-27

- First alpha release of Kimochi.

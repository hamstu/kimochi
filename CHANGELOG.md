# Changelog

What changed in each release of Kimochi, newest first. Written for the people who use the app:
what they can now do, what behaves differently, what was fixed. The app shows this file in
**What's new** (and once, on its own, after it has updated), and the version's section becomes
the GitHub release's notes, so keep it readable.

Add lines under **Unreleased** as you merge work; `npm run release -- <version>` moves them under
the new version with the date. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Headings inside a version are optional: `### Added`, `### Changed`, `### Fixed`, `### Removed`.

## [Unreleased]

- Linux uses the current Kimochi tray glyph with contrast on dark and light panels, and refreshes stale app icons after an update.

- Auto OCR keeps overlay text steady while you hover it or read its dictionary popup, then checks the screen again when you leave both.
- GNOME window shares no longer blink the overlay on every automatic observation; screen captures still hide it to keep annotations out of OCR.

- GNOME: restore annotations and desktop cropping for tiled window shares whose borders extend beyond the screen.

- GNOME: avoid invalid native taskbar notifications during overlay cleanup, and prevent
  delayed extension imports from re-enabling an overlay after it has been disabled.

- Ubuntu/GNOME: hide the passive annotation surface from the dock and window switcher,
  make window pinning work, and keep annotations visible in Kimochi until a window covers the text itself.

- Ubuntu/GNOME: fix vertically displaced overlay text and flickering hover effects when
  the desktop constrains the overlay below its panel. Keep window annotations visible beside Kimochi.

- Ubuntu/GNOME: OCR overlays now use the same hover text, fitted line layout, indicators and
  floating dictionary UI as the other desktop versions. Hovering no longer repeatedly raises
  the dictionary window above the game.

- Manga OCR now reads each column of a speech bubble on its own, the way mokuro does, so every
  character stays in the column it was printed in instead of slipping to the end of the one
  before. Bubbles that touch are told apart more reliably, and long columns are no longer cut short.
- Steam Deck: the welcome guide can add Kimochi to your Steam library, with its own artwork, so you
  can start it from Gaming Mode alongside your game. Settings → General has the same button.
- Steam Deck: in Gaming Mode, Change source lists your running games by name, with their Steam
  icons and live previews, and Kimochi reads the game you choose even while Kimochi itself is in
  front. Screen no longer shows a preview of Kimochi inside Kimochi.
- Linux: Kimochi now shows up under Education in your apps menu, with a description.
- Linux: dictionaries with AVIF images, such as Jitendex, now import on every distribution,
  Steam Deck included, instead of failing with "Could not load image".

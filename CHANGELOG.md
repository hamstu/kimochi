# Changelog

What changed in each release of Kimochi, newest first. Written for the people who use the app:
what they can now do, what behaves differently, what was fixed. The app shows this file in
**What's new** (and once, on its own, after it has updated), and the version's section becomes
the GitHub release's notes, so keep it readable.

Add lines under **Unreleased** as you merge work; `npm run release -- <version>` moves them under
the new version with the date. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Headings inside a version are optional: `### Added`, `### Changed`, `### Fixed`, `### Removed`.

## [Unreleased]

- **Quick Shot:** pressing its shortcut again now closes it if you haven't drawn a box yet, or scans the box you've drawn, the same as Esc and Enter.

## [0.2.2] - 2026-10-29

### Changed

- **New default shortcuts on Windows and Linux:** **Shift+F8** to scan and **Shift+F9** for the controller menu. The old Ctrl shortcuts made many visual novels skip text. Shortcuts you've changed yourself are kept, and macOS is unchanged.
- Shortcuts can now also use **Insert** (alone or with Shift), and on Windows and Linux **Pause** or **Scroll Lock**.
- **Far less CPU use on Windows while a game is running:** Kimochi now reads the game's frames only when it scans, instead of all the time.

### Fixed

- **Windows:** looking up a word no longer steals the game's focus, the Log's dictionary pop-up accepts clicks, tapping Alt no longer freezes Kimochi's windows, Quick Shot's Escape and Enter work while the game is focused, screen recorders can capture the overlay and dictionary when a game window is the source, and quitting really quits instead of lingering in the background.
- **Steam Deck and Gaming Mode:** read-along with a controller is faster and more reliable, the free cursor works in the full-screen dictionary, Hachidori finds common words again on Linux, and Steam's interface no longer crashes when read-along is left open.
- **OCR:** Auto OCR keeps going when the game minimises or the text reader falls behind, the overlay adjusts at once to resolution and scaling changes, and with a whole display as the source Kimochi no longer reads its own windows.
- **Memory and settings:** the Welcome guide frees its memory when closed.

## [0.2.1] - 2026-10-28

### Added

- **Much faster Manga OCR.** This model will now run faster with a compatible GPU, and it's even improved when it falls back to CPU only.
- **Debug info for bug reports.** Settings → About → Debug info has a **Copy** button that puts a report on your clipboard. **Save debug bundle** saves the same report with recent logs as a zip. **Verbose logging** records extra detail while you reproduce a problem.

### Changed

- Kimochi uses far less CPU on the Steam Deck and other Linux PCs.
- "Built-in Yomitan" is renamed to just **Yomitan** ("Runs inside Kimochi").
- Clearer OCR engine descriptions in the welcome guide and Settings

### Fixed

- MeikiOCR on Windows should recognize text correctly again
- Steam Deck: Fixed a whole bunch of compatibility and performance issues with Steam Deck.
- Sentence audio recording works on Linux AppImages, including Steam Deck, instead of stopping with a PipeWire error.
- Kimochi's own windows can be screenshotted and screen-recorded again (Snipping Tool, ShareX and so on). Only the OCR overlay and dictionary pop-ups stay hidden from captures.
- The welcome guide no longer loses Jitendex's download and import progress when you switch windows or steps.
- Switching dictionary engine while Jitendex is importing waits for the import to finish instead of interrupting it.
- Yomitan settings no longer get stuck loading on some Windows machines; if startup does stall, a Retry button appears.

## [0.2.0] - 2026-10-27

- First alpha release of Kimochi.

# Changelog

What changed in each release of Kimochi, newest first. Written for the people who use the app:
what they can now do, what behaves differently, what was fixed. The app shows this file in
**What's new** (and once, on its own, after it has updated), and the version's section becomes
the GitHub release's notes, so keep it readable.

Add lines under **Unreleased** as you merge work; `npm run release -- <version>` moves them under
the new version with the date. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Headings inside a version are optional: `### Added`, `### Changed`, `### Fixed`, `### Removed`.

## [Unreleased]

- Fixed: on Linux, including the Steam Deck, Hachidori showed "No dictionary has an entry" for many common words (今日, 大人, ですね…): its lookups failed whenever a result needed its furigana table.
- Reading along with a controller asks the dictionary for each word directly, in both the pop-up and full-screen styles and with every dictionary: no more pop-ups that never appear, entries from the previous word, or text left selected. A word with no entry now says so.
- Hachidori: reading along stops on the words Hachidori itself finds.
- Hachidori keeps up with read-along: each word's entry shows in about half the time on a Steam Deck.
- Fixed: in Gaming Mode, Hachidori often showed no definition, or a blank dictionary area, for a word you stepped onto, until you stepped off and back. Kimochi no longer takes the arrow keys Steam types for the D-pad, which pulled focus from the overlay at each press and cancelled the lookup.
- In the full-screen dictionary, the outline covers exactly what the dictionary matched, even when that runs into the next word, instead of a second tint over the rest.
- Fixed: after the full-screen dictionary was left through the controller menu, the pop-up style's pop-up opened across the whole width of the screen instead of beside the word.
- The free cursor (left stick) now works in the full-screen dictionary too. Point at any character to look up from there, past a word that was split wrongly; the outline then covers everything the dictionary matched from it, in both styles.
- Fixed: on the Steam Deck, leaving read-along open for several minutes could make Steam's interface crash and restart.
- Steam Deck: opening Kimochi from the controller menu keeps Kimochi in front, instead of the game coming back a moment later or after a volume change.

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

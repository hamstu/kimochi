# Changelog

What changed in each release of Kimochi, newest first. Written for the people who use the app:
what they can now do, what behaves differently, what was fixed. The app shows this file in
**What's new** (and once, on its own, after it has updated), and the version's section becomes
the GitHub release's notes, so keep it readable.

Add lines under **Unreleased** as you merge work; `npm run release -- <version>` moves them under
the new version with the date. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Headings inside a version are optional: `### Added`, `### Changed`, `### Fixed`, `### Removed`.

## [Unreleased]

- Choosing another dictionary engine during a Jitendex import now waits for installation to finish before switching, so the import is not interrupted. Other choices stay selectable.
- Debug logs keep complete JSON records when several windows report at once, including when the log rotates.
- Yomitan settings register their frame again when WebView2 retains the initial blank page's globals. A loading message and Retry remain available if startup does not finish.
- Debug logs explicitly report OCR scans that return no text, including the engine, backend and image size.
- The welcome guide's dictionary setup choices support arrow keys, Home and End, with one Tab stop for the group.
- Changing dictionary engines no longer throws a controller cleanup error when an old settings frame unloads.
- Verbose debug logs now include OCR scan timings and failures from the normal Scan button and Auto OCR, without recording recognized text.
- Debug reports show capture permission status correctly while keeping credentials redacted.
- Steam Deck: the back buttons (L4, R4, L5, R5) and trackpad clicks can be bound in Settings → Shortcuts & Controls, and the controller menu now opens with R4 by default, so both sticks stay with your game.
- Steam Deck: setting a crop area works in Gaming Mode. Draw, move and resize the box with your finger, or move its corners with the sticks, then press A to save or B to cancel. Before, the editor could not be used or closed there.
- New: **Settings → About → Debug info**. **Copy** puts a report for a bug report on the clipboard (Kimochi's version, your OS, CPU, GPU and memory, displays and scaling, OCR engine and dictionary, Kimochi's windows and recent errors), **Save debug bundle** saves it with the recent logs as a zip, and **Verbose logging** records more detail while you reproduce a problem. Tokens, keys, e-mail addresses and your user name are left out.
- The welcome guide's Set up Yomitan step works like the others: choosing Install Jitendex, Choose your own or Do it later only selects it, and the button at the bottom right does it. Before, two of them moved on as soon as you clicked.
- Fixed: in the welcome guide, Jitendex's download and import progress no longer disappears when you switch windows or go to another step and back. The setup always kept going; now the guide shows it again.
- "Built-in Yomitan" is now just **Yomitan** ("Runs inside Kimochi"). It is downloaded when you choose it, so calling it built-in beside "Not downloaded" was confusing. The Yomitan in your browser is still the **Yomitan API**.
- Clearer OCR engine descriptions in the welcome guide and Settings: what each engine is best at, and that none of them needs an API key (Google Lens is free; Cloud OCR comes with a Kimochi account).
- Fixed: Kimochi's own windows (the main window, Settings, the welcome guide) can be screenshotted and screen-recorded again, with Snipping Tool, ShareX or anything else. Only the OCR overlay and dictionary pop-ups stay hidden from captures.
- Fixed: sentence audio recording on Linux AppImages (including Steam Deck), which stopped with a PipeWire error as soon as it started.

## [0.2.0] - 2026-10-27

- First alpha release of Kimochi.

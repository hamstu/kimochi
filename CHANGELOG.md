# Changelog

What changed in each release of Kimochi, newest first. Written for the people who use the app:
what they can now do, what behaves differently, what was fixed. The app shows this file in
**What's new** (and once, on its own, after it has updated), and the version's section becomes
the GitHub release's notes, so keep it readable.

Add lines under **Unreleased** as you merge work; `npm run release -- <version>` moves them under
the new version with the date. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Headings inside a version are optional: `### Added`, `### Changed`, `### Fixed`, `### Removed`.

## [Unreleased]

### Fixed

- On macOS, clicking a source now brings its window to the front even when Kimochi isn't allowed under Accessibility. Before, the app's menu bar took over but its window stayed behind, however often you clicked, until you switched to it with ⌘Tab.
- Cards added from a dictionary popup get their screenshot again when the dictionary saved only part of the line as the sentence (a short phrase cut from a longer line, say). The card now gets the most recent screenshot when no line matches its sentence.
- With the overlay's grouped mode on, a card's sentence is the whole bubble again rather than only the line you looked the word up on, and a word that wraps onto the next line can now be looked up.
- The bottoms of letters like g, y and p are no longer cut off in dropdowns and buttons, such as the OCR model and Dictionary pickers.
- On Windows, a blank white box no longer sits near the top-left of the screen, over whatever is there, until you quit Kimochi. It was the dictionary pop-up's hidden window showing through, and it also turned up in screenshots and recordings when a game window was the source.
- **Windows:** on some PCs Kimochi's windows were drawn larger than Windows' display scale, so a Quick Shot box ran away from the mouse and snapped back when you let go, and highlights lit up away from the cursor. Kimochi now draws its windows at the display's scale, so everything lines up with the mouse again.
- **Windows:** with a pen tablet or touchscreen, Settings and the title bars no longer light up a second row or button away from the mouse, and a Quick Shot box keeps following the mouse while a pen is in range or after a touch.
- With **Verbose logging** on (Settings → About), Kimochi now also records how the mouse, pens and touch reach its windows, to help track down pointer problems.

## [0.3.0] - 2026-10-31

### Added

- **New offline OCR engine, PaddleOCR:** This model is a fast, accurate local engine for game text (PaddleOCR's PP-OCRv6 model). It uses your GPU card where it can, and its model (about 30 MB) downloads separately the first time you choose it in Settings → OCR & Overlay. Shout out to _Nadekai_ in Discord for the suggestion and early benchmarking. 💥
- **Quick Shot:** pressing its shortcut again now closes it if you haven't drawn a box yet, or scans the box you've drawn, the same as Esc and Enter. 🎯
- **Mouse buttons as shortcuts:** on Windows, the scan and controller-menu shortcuts can now be the **middle**, **back** or **forward** mouse button.

### Changed

- **Smarter Auto OCR:** with a local engine selected, that engine now watches the screen for new text itself, so lines no longer flicker out of the overlay when a different engine misreads them. With an online engine or Manga OCR, Auto OCR watches with the best engine already on your computer. You can choose the watching engine under Auto OCR's advanced options. ⏩
- **Faster local OCR on Linux:** MeikiOCR scans on the CPU take about half as long, and use less CPU. ⚡
- **A new look for the overlay.** Scanned text is marked with a soft tinted box instead of an underline, and hovering a word turns it into a floating card in the style of Kimochi's own windows, with a little room around the text and a lighter weight. With the "Group text into regions" setting on, nearby lines share one box that works the same way.
  - **Settings → OCR & Overlay → Overlay look:** choose the highlight colour and how strongly it shows, and whether the cards are light, dark or the same as Kimochi, with live previews of each. A fourth choice, **Blend**, fills each hovered card with the colours behind that word on your screen to blend in with the source. 🎨

### Fixed

- After switching dictionaries, the sidebar and Settings could keep showing "Starting Yomitan…" even though Yomitan was already working.
- With "Group text into regions" on, text read by Apple Live Text or Google Lens now merges correctly into one region per dialogue box.

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

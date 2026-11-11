# Changelog

What changed in each release of Kimochi, newest first. The app shows this in **What's new**.

Add lines under **Unreleased** as you merge work; `npm run release -- <version>` moves them under
the new version with the date. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Headings inside a version are optional: `### Added`, `### Changed`, `### Fixed`, `### Removed`.

## [Unreleased]

### Added

- ⭐ **Linux: pick windows like on Windows and macOS.** On GNOME, KDE Plasma 6, Hyprland, Sway and COSMIC, Kimochi now lists your windows and screens itself, with live previews, instead of opening your desktop's screen-share dialog. No more "click the window you shared" or **Relink window overlay…**: Kimochi knows exactly which window you chose, so the overlay follows it as you move, resize or full-screen it, hides while it's minimised or on another workspace, and **Bring to front** works everywhere. (GNOME needs the GNOME overlay extension, which the welcome guide sets up; other desktops keep the screen-share dialog.)
- **GNOME 47 to 51 are supported.** The GNOME overlay extension, and with it Kimochi's own window list, the on-screen overlay, dictionary pop-ups and region selection, now works on GNOME 47, 48, 49, 50 and 51 as well as 46 (Ubuntu 24.10 and later, Fedora 41 and later). An installed extension updates itself when Kimochi starts, unless you turned it off in GNOME's Extensions app.

### Changed

- **GNOME: the welcome guide sets up the GNOME extension.** On GNOME, the overlay and dictionary pop-ups need a small extension; the welcome guide now sets it up as one of its steps, and Kimochi keeps it up to date on its own, so there's no button for it in Settings any more. If you skipped it, **Set up** next to **Overlay unavailable** in the sidebar does the same.

### Fixed

- When the window you were reading closes, Kimochi now lets go of it and goes back to **Choose a source**, instead of keeping a dead source card and repeating errors. A minimised window, or one on another workspace, is still kept and read again when it comes back.
- **NixOS:** the AppImage now starts with `appimage-run`. Before, it stopped at "libgpg-error.so.0: cannot open shared object file".
- Text hooking no longer shows a long line twice in some games (a line that wraps onto two lines came through once as drawn and once whole).
- **Hyprland (Omarchy):** where Kimochi still uses the screen-share dialog, the overlay now follows a game running through Proton or Wine in a window. Before, Kimochi asked you to "Link the shared window" every time and found nothing to link.
- **Hyprland (Omarchy):** the Scan and Controller menu shortcuts now work without editing your Hyprland config. Kimochi binds them, and Shift for the dictionary, while it runs, and leaves keys your config already uses alone.
- **Hyprland (Omarchy):** hovering a word on the overlay looks it up again. Once Kimochi has seen Shift, the overlay lets your clicks through to the game until you hold Shift, as on Windows and macOS.
- **Hyprland (Omarchy):** a game tiled beside Kimochi at the same size no longer asks you to link its window.

## [0.8.1] - 2026-11-10

### Added

- **Audio hooking on Linux/Steam Deck.** Windows games played through Proton or Wine now give you clean voice clips straight from the game, just like on Windows.

### Fixed

- **Windows: no more yellow capture border.** Kimochi now hides the yellow border Windows draws around selected windows.
- **Steam Deck:** Text hooking is showing again, and Audio hooking now works on the Steam Deck, in both Gaming Mode and Desktop Modes. Plus a bunch of other smaller Steam Deck fixes.

## [0.8.0] - 2026-11-10

### Added

- ⭐ **Audio hooking (Windows).** Ok, so this feature is maybe kind of niche, but I think it's cool! Kimochi will now extract clean voice audio where possible directly from the game, instead of just cutting it out of the system audio. This means you get **clean sentence audio without background music or sound effects**, ready to add to Anki cards. This only works on Windows when you're hooking a game, and only when it _can_ be hooked, but engine support for VNs is pretty good.
  - It's on by default when you're hooking, but you can toggle it off in the sidebar UI.
  - If you find a game where this doesn't work and you'd like it to, let me know. 💬
- **Overlay support on KDE Plasma (Wayland).** The overlay should now work on KDE Plasma!
- **Lookup key**: You can now choose the modifier key you have to hold to look up words on the overlay (default is still Shift) in **Settings → Shortcuts & Controls**. Good for visual novels that skip text with Shift.
- **Hachidori sharing relays (experimental).** Hachidori in Kimochi can now link to a shared Hachidori through a relay (the Hachidori Anki add-on's, or `hachidori-relay`). Go to **Settings → Dictionary → Sharing** in Hachidori to set it up.

### Changed

- UI: Text hooking is now a toggle switch under the source selector in the sidebar. You can seamlessly switch between hooking or just plain OCR while playing a game.
- Text hooking has been improved to work with more game engines and auto-selects their dialogue more reliably. This includes Unity, TyranoScript and RPG Maker MV/MZ games. There should also be fewer parsing issues and hangs.
- **Scan after a button press** was moved to **Settings → Shortcuts & Controls**.
- Controller buttons you've set stay visible in Settings even when your controller is disconnected.
- **Verbose logging** (Settings → About) now stays on for a day, even across restarts, and records more detail to help debug issues, especially on Linux and the Steam Deck.

### Fixed

- The Notebook, Anki and Settings views open faster, without a "Loading…" message.
- Fixed Yomitan lookup timeout errors in the Log.
- Yomitan's popup should close properly when you move off it.
- Hachidori's nested popups/lookups now work!
  - Also, text you select in a Hachidori popup now goes into Anki's `{popup-selection-text}` field.
- Made some fixes and improvements to the overlay text placement algorithm.
- AnkiConnect no longer drops out with "error sending request for url".
- Hachidori and 10ten lookups on macOS should remain quick (macOS was lowering their priority).
- Linux (including the Steam Deck): importing large or many Yomitan dictionaries no longer stops with "not enough space" once they pass about 1 GB.
- Steam Deck Gaming Mode: restarting a game no longer loses its crop. Before, **Crop** and scans failed until you chose the game again.

## [0.7.0] - 2026-11-07

### Added

- ⭐ **Browser extension (early preview).** Read Japanese in pictures on web pages, like manga pages or game screenshots. Click Kimochi in the browser toolbar and pick a picture: Kimochi reads it, adds the text to the Log and draws the text over the picture for your browser's dictionary pop-up (Yomitan, 10ten). With **Auto** on, it reads the picture again when it changes. Each site gets its own session. Choose **Browser** as the source, and install the extension from **Settings → Browser Extension** (Chrome, Edge, Brave, etc).
- ⭐ **Kimochi on the command line.** Install the `kimochi` command from **Settings → Command line** to drive Kimochi from a terminal or a script: scan and print the text, follow the Log, add lines, switch sessions, sources and OCR engines, change settings, and stream events as JSON.
- **Magpie support.** The overlay, hover lookups and dictionary pop-ups line up with games scaled by Magpie and correctly stay above them.
- **A fuller session manager** in the Log's **Manage sessions** and in **Settings → Log & Sessions**: each session's reading time and line count, its description and last five lines, and clearing or deleting several at once (Shift-click ticks a run).

### Changed

- **A tidier sidebar.** Just made some nice tidy and polished CSS changes to the sidebar ✨

### Fixed

- **The overlay works on more Linux desktops.** On Wayland desktops such as Hyprland, Sway and KDE Plasma, the installed app no longer says the overlay isn't supported.
- **Text Hooker: improved text processing.** Some engines send each row of the text box on its own, so the card and the Log showed only the last line. This should be fixed now. We also filter out VN script codes better in the output.
- **Smoother hover cards with Click through text to the game on.** With Hachidori, hover cards no longer flicker as they fade in, and text lights up only while you hold Shift.
- **Mini mode's title bar clean up.** That's it. That's the change :)

## [0.6.1] - 2026-11-05

### Added

- **Help button.** The ? in the title bar takes you to the Discord, lets you request a feature, or lets you report a bug from inside Kimochi, with debug data attached so it's easier to fix.

## [0.6.0] - 2026-11-04

### Added

- ⭐ **Text Hooker on Linux and Steam Deck.** Windows games running through Proton or Wine can now be hooked, in Gaming Mode too, just as on Windows. Native Linux games still use OCR.
- **Text Hooker settings in the controller menu.** Choose the dialogue text, and show, move, resize and style the card without leaving the game.
- **Hide the Text Hooker card** with **Show the card over the game** in Settings → Text Hooker. Lines still reach the Log.

### Changed

- **Faster startup.** The main window appears sooner, already in your theme, with your Log ready.
- **Faster dictionary lookups.** Hachidori, 10ten and the Yomitan API pop-ups load quicker.
- **Less CPU and memory.** Auto OCR no longer keeps re-reading a line with a blinking ▼ or cursor, and OCR engines you switch away from are unloaded.
- **Anki crop on the Text Hooker card**, in place of Crop area, to set what your cards' screenshots show.
- **No controller navigation in Kimochi's windows.** Use touch, a mouse or the keyboard; reading over a game with the controller is unchanged.
- **Settings → About** now credits LunaHook and Textractor, with a logo for every project.
- **Steam Deck Gaming Mode**
  - Steam Deck gets an adjusted UI; a new Source tab sets you up in three steps (choose your game, check how it's read, get back to playing). The UI is scaled up for readability.
  - Kimochi uses much less CPU while you play.

### Fixed

- **Sentence audio** no longer goes missing from a line later on.
- **No crash on quit** while Auto OCR is reading the screen.
- **Manga OCR** reads a game's long horizontal lines whole.
- **The controller menu** opens above the Text Hooker card, and its Recent text matches the Log.
- **Windows and Linux**
  - Auto OCR works with Google Lens and Manga OCR again.
- **Linux**
  - Wayland: scanned text shows over the game reliably, and Hachidori and 10ten look words up there.
  - GNOME: the overlay no longer blocks clicks on the desktop, scanning the whole screen no longer reads Kimochi itself, and the crop editor saves the crop you just drew.
  - Hyprland: a shared window shows its app's name and icon, and each game keeps its own crop.
  - The AppImage plays sounds again, Copy debug info works, and Yomitan's pop-up uses Kimochi's fonts.
- **Steam Deck Gaming Mode**
  - Kimochi follows the game you switch to, with that game's own crop.
  - Other misc. fixes and improvements.

## [0.5.0] - 2026-11-03

### Added

- ⭐ **Text Hooker** is now available as a new source option (Windows-only): choose a game in the source menu and Kimochi reads its text from inside the game, with no OCR required. It downloads a text hooker the first time (LunaHook, about 6 MB; or Textractor if LunaHook can't hook the game), picks the dialogue out of the game's text by matching it to what's on screen, and remembers that choice for the game.
  - **Text Hooker overlay**: each hooked line shows in a card over the game as soon as it comes in, always visible, with its words looked up as usual. With **Auto align** on, OCR finds the line on screen in the background and the card sits over the game's own text. Optionally, you can hold Shift and drag the Text Hooker card yourself to a different location.
  - **Settings → Text Hooker**: defaults for every game, and a page for each game you've hooked, with its icon, its name and its Log session. A game can change any default. Games you've hooked are hooked again automatically when they start. Open it from **Manage** beside **Text hooker** in the sidebar, or from the card's ⋯ menu.
- **10ten's pop-up size** in Settings → Dictionary, under 10ten's settings: **Compact** (new default, the size of Yomitan's), **Medium**, or **Large** (10ten's own). Longer entries fade out at the edge; move onto the pop-up to scroll. For bigger or smaller text, use Font size in 10ten's settings.
- A **hint bar** under the text you're reading says what Shift does. It sits just below the crop area (or the game's window), or at the bottom of the screen for a full-screen game. Close it with its ×; Settings → General → Overlay hints brings it back.

### Changed

- **Clicks go through the overlay's text to the game.** Text boxes over a game's buttons no longer get in the way: without Shift, clicking on them clicks the game. Hold **Shift** to light text up, look words up, click a word, or drag and use the Text Hooker card; once lit, text stays clickable while your pointer is on it, even after you let go of Shift. With a dictionary pop-up open, your next click outside it just closes it and doesn't reach the game. A pop-up you're in, and the card's ⋯ menu once it's open, stay clickable without Shift. Prefer the old way? Turn off **Click through text to the game** in Settings → OCR & Overlay. (Linux Wayland keeps the old behaviour, since Kimochi can't see Shift there.)
- **Kimochi no longer switches to mini mode on its own** when the game goes full screen. Instead, if the game goes full screen on the same screen as Kimochi, Kimochi stays its size and is kept on top of the game until the game leaves full screen; unpin it to stop that. On another screen, nothing changes. To get mini mode back, turn on **Switch to mini mode** in Settings → General → Full-screen games; it now only happens when the game is on Kimochi's screen.

## [0.4.0] - 2026-11-03

### Added

- **Exclude overlay from screen recording** in Settings → OCR & Overlay. This is on by default, but if you want to be able to screenshot the overlay and other parts of Kimochi, you can turn it off. 

### Changed

- **Auto OCR is much quicker**, especially with a local engine on a machine without a fancy GPU.
- **Japanese only** filtering has been tweaked and renamed to **Drop lines**: by default the Log and the overlay skip lines with no Japanese in them. Choose **Mostly not Japanese** to also skip lines that are mostly something else, with only a kana or two, or **Off** to keep everything. It's in Settings → Log & Sessions and Settings → OCR & Overlay (the same setting in both).
- 10ten now waits for <kbd>Shift</kbd> before looking a word up, like Yomitan and Hachidori, instead of opening its pop-up whenever the pointer crosses a word.

### Fixed

- On Windows, Auto OCR now works properly with OneOCR as the engine.
- With the overlay's grouped mode on, a card's sentence is the whole bubble again rather than only the line you looked the word up on, and a word that wraps onto the next line can now be looked up.
- On Windows, fixed an issue that was showing a blank white box on the screen.
- Hovering the source card no longer covers it with a picture of the source window when that window sits behind Kimochi.
- On Windows, holding your lookup key (Shift) while moving onto a word in the overlay opens the dictionary again.
- **Windows:** Fix some issues with screen DPI and scaling when rendering quick shot and the overlays, as well as issues with pen/tablet devices.
- With **Verbose logging** on (Settings → About), Kimochi now also records how the mouse, pens and touch reach its windows, to help track down pointer problems.
- Cards added from a dictionary popup get enhanced with a screenshot again when the dictionary saved only part of the line as the sentence.
- On macOS, clicking a source now brings its window to the front properly.

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

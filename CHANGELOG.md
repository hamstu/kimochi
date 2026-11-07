# Changelog

What changed in each release of Kimochi, newest first. The app shows this in **What's new**.

Add lines under **Unreleased** as you merge work; `npm run release -- <version>` moves them under
the new version with the date. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Headings inside a version are optional: `### Added`, `### Changed`, `### Fixed`, `### Removed`.

## [Unreleased]

### Added

- **Read in languages other than Japanese (experimental).** Choose the language you're learning in Settings → Language or in the welcome guide; it goes with your Kimochi account to your other computers. Japanese works just as before. Translations and AI explanations are in English, whatever the language.
- **The OCR engine follows the language.** Engines that can't read it are left out of the list, Kimochi switches to one that can when you change language, and the engine you used for a language comes back when you return to it. Auto OCR watches the screen only with engines that read it too. On macOS, Apple Live Text reads 24 of the languages, among them Turkish, Indonesian, Polish, Dutch, Czech, Romanian and the Scandinavian languages.
- **Text in the language you're learning is kept.** The Log and the overlay keep its lines instead of dropping them as "not Japanese", words are joined with spaces where the language uses them, lookups start at the whole word under the pointer, and Read along and the controller step through it word by word. In a language that spaces its words, the Log's reading stats count words and words per hour. The text is drawn in that language's own fonts, sized to match the screen and wrapped between words, and Settings → OCR & Overlay previews the overlay in your language.
- **Windows and Linux: the Text Hooker reads games in your language's text encoding.** A Korean, Chinese, Russian, Thai, Greek, Turkish, Vietnamese or European game that sends its text as older non-Unicode strings no longer comes out as garbled characters, and it picks the dialogue in those games the way it does for Japanese ones. Japanese games are read as before.
- **Built-in Yomitan keeps a dictionary profile for each account.** Your first account uses Yomitan's default profile; an account set to another language gets a profile of its own, and switching account switches profile. Settings → Account lets you choose which Yomitan profile goes with the account. Your dictionaries are still shared on this computer.
- **Look up on hover.** Turn it on in Settings → Shortcuts & Controls to look up a word on the overlay just by resting the pointer on it, no key held. Moving the pointer across the screen doesn't flash pop-ups at every word on the way, and clicks still go to your game. Not available on Linux Wayland yet.
- **Windows: a controller that is listed but whose buttons do nothing can be read with XInput instead.** Turn on **Read controllers with XInput** in Settings → Shortcuts & Controls; it takes effect right away, so the button test shows whether it helped. It works with Xbox-style (XInput) controllers only.
- **Fix a line in the Log.** Double-click a line, choose **Edit line** from its menu, or press **E** over it to correct the text: a misread が for か, or a place name you'd rather type in than draw a new OCR region for. Press Enter to save or Esc to cancel. Kimochi keeps the text as it was read, so the next reading of the same line still isn't logged twice. **Restore original** in the menu puts back what was read. **Explain** is now **X**.
- **Write your own notes in the Log.** Choose **Add a note** at the end of the Log, or press **A**, to add a note right where you are in the story, with the time. Notes take Markdown, stand out from the lines around them, and fold away when they're long (click to open). Type **@** to mention a character, place or thing from your Notebook: pick it from the list and its name goes in, linked like it is in any line. Your notes are in the **Notebook** too, under **Notes**: edit them there, or choose **Show in Log** to jump back to the spot. The Log's footer counts them; click the count to see them all. Notes sync like the rest of your Log.

### Changed

- **Some features stay Japanese-only for now** and are hidden in other languages: read aloud (its voices are Japanese), word audio, and the sentence-furigana and pitch-accent card fields. Sentence audio still finds each line's clip by timing. The Hachidori and 10ten dictionaries read Japanese only and can't be chosen for another language; use Built-in Yomitan or the Yomitan API.
- **The activity ticker at the foot of the Log is quieter.** After a scan it shows what happened for a few seconds, then fades away; hover it or click it to keep it (a click opens the recent history). While Auto OCR runs it no longer reports every scan: it just says **Auto OCR is running**, and speaks up only when something goes wrong. The new cog at its end opens its setting, where you can turn it off (Settings → Log & Sessions → Activity ticker).
- ⚡ **Auto OCR is about twice as fast with local engines.** New lines reach the overlay and the Log in roughly half the time, and Auto OCR adjusts to your computer: it checks the screen more often when that's cheap, and backs off on slower or busier machines.
- **Auto OCR no longer drops lines when dialogue moves quickly** with a local engine.
- **Auto OCR no longer waits up to 3 seconds for a new line when your mouse is over the text.**
- **Slow engines (OneOCR, Screen AI on modest PCs) skip work while text is still typing out**, and read each line once it's done.
- **Browser extension: Auto works properly on readers that draw pages on a canvas (like ComicWalker).** It reads each new page as you turn to it, no longer reads the same pages again and again (so the text stops flickering), and uses less CPU. With Auto off, it now tells you when the page changed.
- **Windows:** PaddleOCR and MeikiOCR use about a quarter less CPU while Auto OCR runs, with no loss in speed.

### Fixed

- **Linux: Text Hooker works with games run through Flatpak apps** like Bottles, Lutris, Heroic or Flathub's Steam, where it used to get stuck on "Starting…". If a game can't be hooked, it now says why.
- **GNOME: the overlay no longer blocks clicks on your game and other windows.** Clicks outside the text go where you click again, and the text works as on Windows and macOS: hover with **Shift** to look words up (the highlight stays steady instead of flickering), and without Shift, clicks on the text go to the game too. With a dictionary pop-up open (Yomitan, Hachidori or 10ten), the first click anywhere else closes it without reaching the game, and the next click goes to the game. Dragging the game's window no longer makes the text jump and blink along behind it: it fades out while the window moves and back in where it stops.
- **GNOME: setting up the GNOME extension no longer fails with "This integration supports GNOME 46–51; this is"** on a supported GNOME (seen on Ubuntu 26.04 with GNOME 50). Kimochi now asks GNOME itself which version is running, and if it ever can't tell, it says why.
- **The Log's reading time no longer drops to a minute when you take a break.** A stretch of reading now keeps all of its time once you stop, instead of only the last minute of it.
- **A word that wraps onto the next line can now be looked up whole** with Apple Live Text, OneOCR, Google Lens and Screen AI (when **Group text into regions** is off). Before, a lookup stopped at the end of the line, so デジ|タル found only デジ. Lines that only sit near each other, like a speaker's name over their dialogue, are still kept apart.
- **A setting Kimochi doesn't recognise no longer leaves a blank gray window** (for example after trying a newer version). It falls back to the default, and if a window still can't load, it says what went wrong, with **Reload window** and **Copy details**.
- **Yomitan:** hovering the last word of a line on the overlay or the Text Hooker's card no longer looks it up without its last character (`食べまし` instead of `食べました`). Yomitan's **Layout-aware scan** stays on, so lookups and Anki sentences still stop at the edge of each bubble.
- **Controllers: Kimochi now reads the controller you're pressing.** If another controller is listed first (for example a virtual one from Steam Input or DS4Windows), its buttons no longer go unnoticed. A primary you chose in Settings still comes first.
- **Settings → Shortcuts & Controls → Button test now shows everything your controller sends**, even buttons Kimochi can't map yet, and says when input is coming from a controller that isn't the active one.
- **An unreadable settings file is kept** as `settings.json.unreadable-…` beside it before Kimochi starts over on defaults, instead of being overwritten by the next change.
- **Text Hooker: a word split across two lines in the card is looked up whole.** Hovering 自転 when the game breaks 自転車 as 自転 / 車 now finds 自転車, with Yomitan, Hachidori and 10ten, and Read along steps over it as one word.
- **Windows: scans no longer get stuck on "a scan is already running"** until you restart Kimochi, after Windows fails to close the capture of a game that quit.
- **Hovering a word on the overlay looks up the word you're pointing at after an ellipsis or a pair of brackets** (like `……` or `。」`). Before, the words after them could be up to a character and a half away from the text underneath, especially with Apple Live Text, and on Windows after closing brackets.
- **The Yomitan API dictionary now looks words up on the overlay with the lookup key you chose** (Ctrl, Alt or Command), not only with Shift.
- **Group text into regions:** a word that wraps onto the next line now looks up correctly when a region covers columns side by side, or blocks of vertical text one above the other (as on a manga page). Before, the lookup ran on into the other column or block.
- **Updating on Windows finishes when Kimochi was started by a launcher or a terminal.** If whatever started Kimochi closed while the update installed, the installer could stop partway and leave Kimochi unable to start ("This app can't run on your PC") until it was reinstalled. The installer now runs on its own and always finishes.

## [0.9.0] - 2026-11-11

### Added

- 🪟 **Linux: Kimochi's own window picker.** On GNOME, KDE Plasma 6, Hyprland, Sway and COSMIC, Kimochi now lists your windows with live previews, just like on Windows and macOS. No more desktop screen-share dialog and no more 'linking': the overlay follows your game as you move, resize or full-screen it, and **Bring to front** works everywhere.
- 🔍 **New OCR engine: Screen AI.** The on-device OCR from Google Chrome, now in Settings → OCR & Overlay on macOS, Windows and Linux. It's fast, very accurate on game text (horizontal or vertical), and works offline. It's a one-time download of about 80 MB, or none if Chrome already has it.
- 🎴 **New OCR engine: VOCR6.** A tiny (3.6 MB), super-fast offline OCR made for visual-novel dialogue boxes. Great for horizontal dialogue and speaker names; for manga, vertical text or busy screens, use another engine.
- 🐧 **GNOME 47 to 51 are supported** (Ubuntu 24.10+, Fedora 41+), not just GNOME 46.
- 🎮 **Steam Deck in Desktop Mode: look words up with a button.** Hold the L4 back grip and move the pointer over text with the trackpad. You can pick another button in Settings → Shortcuts & Controls.
- A **maximize** button in the title bar of Kimochi's windows.

### Changed

- **GNOME: the welcome guide sets up the GNOME extension** for you, and Kimochi keeps it up to date.
- **Text hooking:** the hooked-text menu no longer jumps around as lines arrive, and only lists text with Japanese in it (the rest is under **Show all**).

### Fixed

- **Hachidori** no longer gets stuck at startup.
- Closing a game/source window now resets the app to **Choose a source**, instead of leaving the broken one there.
- **NixOS:** the AppImage now starts with `appimage-run`.
- Text hooking no longer shows long lines twice in some games.
- **Steam Deck in Desktop Mode:** the controller menu button (R4) and other controller shortcuts now work, whichever window has focus.
- **Linux:** changing the crop area, or clicking the source preview, now brings the game to the front.
- **Linux (Wayland):** **Crop area** works on every monitor, not just the main one.
- **KDE Plasma and Hyprland:**
  - A new crop replaces the old one, and **Clear OCR crop area** works.
  - Whole-screen scans no longer miss text in the top-left corner.
- **Hyprland (Omarchy):**
  - The overlay now follows Proton and Wine games.
  - The Scan and Controller shortcuts work without editing your Hyprland config.
  - Hovering a word on the overlay looks it up again.
  - A game tiled next to Kimochi no longer asks you to link its window.
- Verbose logging records more about controllers, to help debug ones that aren't detected.

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

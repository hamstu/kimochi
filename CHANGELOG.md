# Changelog

What changed in each release of Kimochi, newest first. Written for the people who use the app:
what they can now do, what behaves differently, what was fixed. The app shows this file in
**What's new** (and once, on its own, after it has updated), and the version's section becomes
the GitHub release's notes, so keep it readable.

Add lines under **Unreleased** as you merge work; `npm run release -- <version>` moves them under
the new version with the date. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Headings inside a version are optional: `### Added`, `### Changed`, `### Fixed`, `### Removed`.

## [Unreleased]

- With Auto OCR on, the Scan button (and its shortcut) is now **Force rescan**: it clears what was
  read and scans again at once, starting Auto OCR over. A way out when Auto OCR seems stuck.
- Sound effects are simpler: every button, switch and menu makes the same click (the sidebar keeps
  its whoosh). Settings → General has separate switches for scan sounds and click sounds under
  Sound effects, and a Volume slider for all of them (50% by default).
- Gaming Mode: choosing Scan from the menu no longer makes the text flicker as reading starts.
- macOS: Mini Mode now shows on top of a game in full screen.
- Settings → Log is now Log & Sessions, with your sessions listed at the bottom: drag to reorder,
  click a name to rename, switch, delete or add one. Reset Log settings is gone.
- Settings → OCR & Overlay has an Auto OCR section with the same switch as the main window; its
  tuning (adaptive polling and the rest) is under Advanced options.
- Settings → Sources shows both macOS permissions, Screen Recording and Accessibility, with a
  button to allow either one that isn't.
- Settings → Translation & AI offers Kimochi cloud or your DeepL key; Automatic is gone.
- Settings → Dictionary and Anki say less: the engine's settings button appears once it is
  downloaded, and Anki asks you to download a dictionary until you have one.
- 10ten's settings button in its pop-up opens its settings instead of leaving the window on
  "Loading…" (which also stuck opening them from Settings afterwards).
- Gaming Mode has a new look that matches the rest of Kimochi, in light or dark to follow your
  Appearance setting. The controller menu is now a ring of large icons around a centre that names
  the action you're pointing at. Read-along's hint bar, the controls sheet and Recent text use
  bigger text and buttons, easier to read on a TV or handheld.
- New **Game Mode** page in Settings to choose how Read along shows the dictionary: **Pop-up**
  beside the word (the default) or **Full screen**, which shows the whole scanned text across the
  top of a dimmed screen with one word lit and its dictionary entry below. Full screen works with
  every dictionary: the Yomitan API shows its entries there, and Built-in Yomitan, Hachidori and
  10ten show their own pop-up filling that space. Move word to word with the D-pad or arrow keys,
  through a word's entries with the shoulder buttons, and add the entry to Anki with A. The
  controller's buttons stay in Settings → Shortcuts & Controls.
- Sentence audio: turn on Record and attach sentence audio in Settings → Anki and each card you
  add gets the spoken audio of the line you mined it from, cut from what your computer was playing
  and trimmed to the voice. It works with Built-in Yomitan, Hachidori and the Yomitan API pop-up,
  into a field you choose (SentenceAudio by default), and never replaces a field that is already
  filled. Audio is only kept in memory. On macOS it uses the Screen Recording permission; on Linux
  and the Steam Deck it needs PipeWire.
- Removing a dictionary in Hachidori's settings now works on macOS: the "Remove …?" question
  (and every other confirmation, alert or question an engine's settings page asks) now appears
  instead of being silently answered "Cancel".
- Links in Hachidori's and 10ten's settings (privacy policy, themes, AnkiConnect, dictionary
  sources and credits) open in your web browser instead of doing nothing or opening inside the
  settings window.
- Hachidori's Download backup, Download debug info and Anki add-on buttons now ask where to save
  the file, instead of doing nothing.
- You can drop dictionary files onto Hachidori's import area and drag its dictionaries to reorder
  them; the settings window used to swallow every drag.
- Links in Built-in Yomitan's settings, info and support pages and in its pop-ups (the wiki,
  AnkiConnect, dictionary homepages, links inside definitions) open in your web browser, instead
  of doing nothing or loading the website inside the settings window. Its own pages, such as the
  search page or "Anki settings" from a pop-up, open in the Yomitan settings window.
- Built-in Yomitan's Export settings, Export dictionary collection and Anki deck export now ask
  where to save the file, instead of doing nothing. Dropping dictionary files onto its import area
  works too.
- Opening one of Built-in Yomitan's pages from a pop-up or another window no longer replaces the
  Yomitan settings window with a bare page that couldn't be moved or closed.
- Built-in Yomitan's recommended dictionaries for languages other than Japanese can be installed.
- The mouse cursor no longer flickers between an arrow, a hand and a text cursor when you hover
  buttons, text and input fields (like a notebook's name fields) in Kimochi's windows.
- A dictionary that isn't downloaded yet now says so in the sidebar and in Settings, instead of
  "Starting the dictionary…" forever, and its settings button waits until it's downloaded and
  running (Settings → Anki's button too).
- 10ten's setup note no longer says lookups wait for its download: it looks words up straight away.
- With the Yomitan API, the pop-up over your game only shows Add to Anki once a deck and note type
  are chosen, as the Log's pop-up does, and Settings → Anki says what's still missing.
- Settings → Anki keeps showing your deck and note type while Anki is closed, and the field
  mapping updates right away after Detect or an import.
- The Yomitan API address in Settings → Dictionary is saved when you leave the field, and an
  address that can't work is pointed out instead of saved.

- Hachidori imports dictionaries on several threads on macOS, Windows and Linux, as it does in
  Chrome: up to twice as fast (Jitendex in about a second instead of nearly two on a Mac). Your
  dictionaries are copied to Hachidori's new home in the background once, and the faster imports
  start from the next launch; nothing is removed from the old place.
- The sidebar's OCR model, Dictionary and Change source menus are tidier: each icon now sits beside
  both its name and its description, at every interface size, and descriptions stay on one line.
- Switching to the Yomitan API no longer opens its setup every time: Kimochi checks that it answers
  and only walks you through the setup if it still doesn't after a few seconds.
- Anki has its own page in Settings, whatever dictionary you use. It explains how your dictionary
  adds cards, with a button to its Anki settings. With the Yomitan API it also shows whether
  Kimochi can reach AnkiConnect (and why not: Anki not running, a wrong port, an API key needed).
- With the Yomitan API, **Detect from Anki** in Settings → Anki finds your Lapis, Kiku or Senren
  note type and the deck you mine into, and fills in the fields, so there's no need to export your Yomitan settings
  first.

- Built-in Yomitan and Hachidori can add Anki cards with AnkiConnect's default settings: there's
  no longer any need to edit its `webCorsOriginList`.

- AnkiConnect on another port, or with an API key, works for every dictionary. Built-in Yomitan and
  Hachidori use the address and key in their own Anki settings; the Yomitan API uses the ones in
  Settings → Anki.

- Built-in Yomitan is updated to 26.10.22.0. With the new AnkiConnect (26.10), a word already in
  Anki under another note type no longer hides the pop-up's Anki buttons.
- When a Kimochi update brings a new version of a dictionary engine you've downloaded, it updates
  in the background and your current version keeps working until the new one is ready and
  checked. Progress shows in Settings → Dictionary. If you're offline, Kimochi tries again
  later. Your dictionaries and settings are kept, and engines you never downloaded stay that way.

- With the Yomitan API, the pop-up's audio plays as soon as the word shows, instead of up to a few seconds later for common words with many entries.
- With the Yomitan API, Add to Anki is a small + beside each entry's audio button. It turns into a green check once the card is in Anki (click it to open the card there), or a red alert if adding failed (hover for why, click to try again).
- With the Yomitan API, clicking the pop-up over your game no longer closes it, so you can click into it and scroll.
- Hold Shift over a word inside a dictionary pop-up to look it up in another pop-up on top, as in Yomitan, in the Log and over your game. It works with Built-in Yomitan (as deep as its "Maximum number of child popups" setting allows) and with the Yomitan API (up to five pop-ups). Click back in an earlier pop-up to close the ones above it.
- Holding Shift over a dictionary pop-up no longer looks up the Log line underneath it, and Built-in Yomitan's nested pop-ups in the Log open beside their word.

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

- The welcome guide's permission steps are shorter: each has a "Why does Kimochi need this?" link with the full explanation, and Accessibility shows where to find Kimochi in System Settings, as Screen Recording does.
- The welcome guide's Built-in Yomitan step is now a clear choice: install Jitendex (recommended), choose your own dictionaries in Yomitan's settings, or do it later.
- Choosing a dictionary engine is quicker to read: shorter descriptions, and the pop-up picture is a thumbnail beside them (click it to see it full size), so a download's progress stays in view.
- Choosing the Yomitan API as your dictionary no longer downloads Built-in Yomitan: lookups go straight to the Yomitan in your browser.
- The welcome guide no longer has a "Choose what to read" step on Linux; choose your source from the sidebar once Kimochi is open.
- Kimochi's Steam library artwork shows just the Kimochi name.
- Reading with a controller: Y switches between stepping by word and by character, so you can
  start a lookup anywhere in a word. The left stick moves a free cursor that looks up whatever
  character it rests on. A moves into the dictionary pop-up, where the D-pad picks a button, such
  as Add to Anki or Play audio, and A presses it. X plays the audio, and View lists every control.
  All of these buttons can be changed in Settings → Shortcuts & Controls, which also warns when
  two actions share a button.
- The Log no longer highlights the wrong words as notebook names. After switching sessions, or
  when a line's text was updated, a line could show another line's name at the same position.
- The furigana and small-text filter's strength is now five named steps, from Gentle to Strict,
  behind the arrow beside its switch, and each step says what it removes. Overlay mode and the
  Yomitan API are no longer marked Experimental.
- Sound effects play the moment you press, rather than a beat later: buttons and switches sound
  on the press instead of the release, and every sound is ready in advance and starts without a
  gap.
- The tray icon is the Kimochi icon now, drawn in black and white in the macOS menu bar and in
  colour on Windows and Linux. Clicking it opens a native menu to open Kimochi, switch Mini Mode,
  open Settings or quit, in place of the old pop-up panel.
- macOS: Settings… is in the Kimochi menu, with ⌘, to open it. The developer-only Panels menu is
  gone from the menu bar.
- Settings → About shows the version you're running, its updates, links to the website,
  documentation, Discord and source code, and credits the open-source projects Kimochi is built
  on. About Kimochi in the macOS menu and in the tray menu opens it. Updates moved here from
  General.
- Automatic scanning turns off when you remove the source, or when the window it watches closes,
  instead of failing until it gives up.
- Reading with a controller no longer quits Kimochi when you press A. While the controller menu or
  reading was open, the Log window could also act on your presses and land on its Quit button.
- 10ten: hovering a word shows its definition again, including while 10ten is still downloading
  its full dictionaries, and reading with a controller now looks words up in 10ten too. LB and
  RB switch between its Words, Kanji and Names tabs in both directions.
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

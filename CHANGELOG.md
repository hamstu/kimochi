# Changelog

What changed in each release of Kimochi, newest first. Written for the people who use the app:
what they can now do, what behaves differently, what was fixed. The app shows this file in
**What's new** (and once, on its own, after it has updated), and the version's section becomes
the GitHub release's notes, so keep it readable.

Add lines under **Unreleased** as you merge work; `npm run release -- <version>` moves them under
the new version with the date. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Headings inside a version are optional: `### Added`, `### Changed`, `### Fixed`, `### Removed`.

## [Unreleased]

- The sidebar's OCR model, Dictionary and Change source menus are tidier: each icon now sits beside
  both its name and its description, at every interface size, and descriptions stay on one line.
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
- With the Yomitan API, clicking the pop-up over your game no longer closes it, so you can click into it and scroll.
- Hold Shift over a word inside a dictionary pop-up to look it up in another pop-up on top, as in Yomitan, in the Log and over your game. It works with Built-in Yomitan (as deep as its "Maximum number of child popups" setting allows) and with the Yomitan API (up to five pop-ups). Click back in an earlier pop-up to close the ones above it.
- Holding Shift over a dictionary pop-up no longer looks up the Log line underneath it, and Built-in Yomitan's nested pop-ups in the Log open beside their word.
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

# Changelog

What changed in each release of Kimochi, newest first. Written for the people who use the app:
what they can now do, what behaves differently, what was fixed. The app shows this file in
**What's new** (and once, on its own, after it has updated), and the version's section becomes
the GitHub release's notes, so keep it readable.

Add lines under **Unreleased** as you merge work; `npm run release -- <version>` moves them under
the new version with the date. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Headings inside a version are optional: `### Added`, `### Changed`, `### Fixed`, `### Removed`.

## [Unreleased]

### Added

- Right-click a line in the Log for its menu, the same one as its ⋯ button: copy, translate,
  explain or delete it. With text selected, the menu also copies the selection or adds it to the
  Notebook. Kimochi's own menu replaces the system's; ⌘C / Ctrl+C still copies a selection.
- Right-click an entry in the Notebook, or use its ⋯ button, to edit it, copy its name, turn its
  matching in the Log on or off, or delete it.
- Manga OCR's text is shown in a manga-style typeface: Zen Kaku Gothic Antique, lighter than the
  overlay's usual bold, with the classic kana shapes manga lettering uses. Text that is big for
  its page, a shout or a heading, is set bold. The font is bundled, so nothing is downloaded.
- Full-screen games and other desktops work. On macOS the overlay, Quick Shot and the dictionary
  pop-up now appear over an app in its own full-screen Space, and the source picker lists windows
  on other Spaces, tagged "Full screen" or "Desktop 2". On Windows they follow you to whichever
  virtual desktop the game is on, and the picker lists windows on other desktops too. A window
  on another Space or desktop starts reading when you switch to it.
- Google Lens is a new OCR engine, and the default for new installs: accurate on Japanese,
  horizontal or vertical, with nothing to download. It sends each capture to Google, so choose a
  local engine in Settings → OCR & Overlay if you'd rather nothing leave your computer. Existing
  installs keep the engine they use.

- Kimochi updates itself. A bundle checks GitHub Releases quietly after launch and every six
  hours; a found update appears above Settings in the sidebar, where you download it and choose
  when to restart. Settings → General → Updates checks on demand and shows the version.
- A guided setup for the Yomitan API, the dictionary option that looks words up through the
  Yomitan already in your browser. Kimochi finds the helper your browser needs (its own or the
  official one), installs its own in one click if you have none, shows how to turn the API on in
  Yomitan, and tells you the moment it connects. It appears in the first-run guide and in
  Settings → Dictionary.
- Choosing a dictionary (Settings → Dictionary, and the first-run guide) shows a picture of each
  engine's pop-up looking up a word in game dialogue; click it to see it full size.

### Changed

- The Notebook has a status bar across its foot, like the Log's, with the session picker at its
  right. Its editor pane can be resized by dragging its edge (double-click to reset); its own foot
  says when your last edit was saved, beside the entry's mentions and Delete.
- An empty Notebook offers **Add item**, which asks whether to add a character, a place or a thing.
  With room to spare, the Notebook's toolbar spells out **Import from VNDB**.
- Selecting text in the Log no longer pops up an "Add to notebook" button over it; right-click the
  selection instead.
- Keyboard keys shown in the app (the Notebook's / search hint and its footer) look like key caps,
  their symbol centred.
- The session picker moved from the sidebar to the Log's footer, beside the ⋯ menu: click the
  session's name to switch, rename or manage sessions. Its place in the sidebar is now a
  **Dictionary** picker, for switching dictionary engines without opening Settings (Manage still
  opens Settings → Dictionary).
- Kimochi is now signed and notarised on macOS and signed on Windows, so it opens without
  "unidentified developer" or "unknown publisher" warnings.
- The OCR model picker in the main window lists each engine as Settings does: its icon, its
  name, whether it runs online or on your computer, and a short line about what it is for.
- The dictionary options have clearer names: **Built-in Yomitan** (a copy of Yomitan inside
  Kimochi, set up with its own or your exported dictionaries) and **Yomitan API** (formerly
  "Kimochi pop-up"). Your choice is kept.
- Choosing an OCR or dictionary engine in Settings no longer switches the moment you click it:
  clicking an engine shows what it does, and **Use** (for example "Use Google Lens") at the top of
  its panel switches to it. The engine in use has a green check in the list, and each engine shows
  its own icon.

### Fixed

- Sessions can be reordered by dragging again in **Manage sessions**: the row lifts and follows
  the pointer while the others slide aside, without the rest of the window flickering. From the keyboard, focus a handle, press Space, move with the arrow keys
  and press Space to drop.
- Manga OCR's ellipses are ellipses again. It spelled every … as three full-width periods, so
  a bubble's …… was drawn as six dots a whole character apart and read that way in the Log; it is
  now ……, set compactly in vertical text, at the bubble's size.
- Short vertical text in manga (……／かう, a sound effect like たゆんっ) is no longer shown as
  horizontal when it's scanned as part of a page: text whose shape can't tell its direction
  follows the rest of the page. Horizontal titles and captions stay horizontal.
- Speech bubbles or narration boxes whose outlines run together, read by Manga OCR as one block,
  are no longer lettered with their characters stretched far apart to fill the joined shape. The
  text is set at its natural spacing, keeps its columns and reading order, and breaks columns after
  a pause (……, 。, ？, 」) the way the original does. Slanted handwritten columns stay separate
  columns instead of being run together.
- A big word in the overlay (キルコ嬢, a lone かう) is set at its own size again, its characters
  together as on the page. It was shrunk to the size of other text that merely lined up with it
  elsewhere on the page, and its characters spread far apart to fill its box.
- In a speech bubble of several columns, each overlay column now starts with the character the
  original's does. A short first column (…おい) no longer loses its words to the next one, which
  then came out cramped; the columns are worked out together, and follow Japanese line-breaking
  rules (no column ends on 「 or starts with 、。」…).
- Manga OCR reads small snips. A Quick Shot drawn around a single bubble or a few words used to
  come back empty or garbled, because the text finder blew the snip up to page size first. It
  now looks at a snip at its own size, and a lone line it still can't place is read whole. A line
  found twice no longer appears twice in the Log.
- Manga OCR's overlay text on vertical speech bubbles is readable again. A bubble is lettered in
  its columns at one size, and no text is drawn over the furigana. Before, the same bubble could
  show tiny and huge text side by side.
- On Windows and Linux, a scrollbar no longer flickers in the sidebar every few seconds while
  the source preview refreshes.
- Without Screen Recording permission, the source picker now offers **Allow Screen Recording…**,
  which opens System Settings, instead of only an error message.
- The Yomitan API helper now installs correctly on Windows, for every supported browser.
- The Built-in Yomitan pop-up over the Log no longer has a white border in dark mode: its frame
  now matches the pop-up's own theme, light or dark.
- Text over the game now lines up with the game's own text, character for character, with every
  OCR engine and in both overlay modes: long words and lines no longer drift, each line is drawn
  at one size, a paragraph or speech bubble read as a whole is laid line by line over its own
  lines, and a space the OCR left out no longer pushes the rest of the line along. Hovering a
  word lights it without zooming it, so it stays exactly over the word you are reading.
- Switching from the game to Kimochi's main window or Settings hides the text over the game, as
  switching to any other app does; it no longer floats over Kimochi.
- Opening the controller menu (or the gamepad-mode shortcut) no longer brings Kimochi's main
  window in front of the game, and a scan from the menu no longer flips the game and Kimochi back
  and forth: only the menu, the scanned text and the dictionary pop-up appear over the game.

### Removed

- Text to speech (read aloud) and Kimochi's own Cloud OCR are unavailable in public builds for
  now. If Cloud OCR is your selected engine, scans say it needs an access key: choose another
  engine in Settings → OCR & Overlay. The OwOCR (WebSocket OCR) engine has been removed; if it
  was selected, Kimochi uses the default engine instead.
- Auto-scan is now started from your controller (the gamepad trigger in Settings → OCR &
  Overlay) or a scan shortcut; the keyboard "Trigger keys" option is gone on every platform.
  On macOS, Kimochi no longer needs Accessibility permission, and you can remove it in System
  Settings → Privacy & Security → Accessibility.

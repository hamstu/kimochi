# Changelog

What changed in each release of Kimochi, newest first. Written for the people who use the app:
what they can now do, what behaves differently, what was fixed. The app shows this file in
**What's new** (and once, on its own, after it has updated), and the version's section becomes
the GitHub release's notes, so keep it readable.

Add lines under **Unreleased** as you merge work; `npm run release -- <version>` moves them under
the new version with the date. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Headings inside a version are optional: `### Added`, `### Changed`, `### Fixed`, `### Removed`.

## [Unreleased]

- Optional Kimochi accounts. Sign in or create one from Settings → Account: Kimochi opens your browser, you confirm the code it shows, and Kimochi comes back signed in. Nothing else in Kimochi needs an account.
- Signed in, you can use Kimochi cloud OCR, read aloud, translation and explanations within free monthly allowances; Settings → Account shows how much of each you've used and when they reset.
- Translation can use Kimochi cloud or your own DeepL key (Settings → Translation & AI → Translate with), and Explain can use Kimochi cloud instead of a command-line model.
- Back up your preferences and sessions (lines, notebook and images) to your account, automatically or with Back up now, and restore them on this or another computer. Your DeepL key and other secrets are never uploaded.

- Load settings pages, diagnostics and the Notebook on demand, and avoid duplicate settings reads during startup.
- Settings in the main window: the page list stays in place while you scroll a page again, and pages switch with a quick fade instead of a "Loading settings…" line.
- Stop refreshing source screenshots while the main window is hidden, reducing background capture work.
- Prepare local MeikiOCR and Manga OCR scans directly from captured pixels instead of decoding them from PNG, and reuse cloud OCR connections between scans.
- Windows and Linux: keep the selected MeikiOCR engine warm after its startup check so the first scan does not load the models twice.

- Speed up dictionary lookups with direct streaming between windows, keep Hachidori hover requests from building a backlog, and stop idle popups from continuously re-measuring themselves.

- macOS: the controller menu opened from a keyboard shortcut now takes the keyboard too, so the game no longer reacts to the arrows, Return or Escape while you use the menu.
- Kimochi now opens in front and focused when you launch it.
- macOS: opening the controller menu or the word cursor no longer brings Kimochi's main window up over the game, and clicking the source card reliably brings the window in front of Kimochi.
- Prevent a blank, click-through window from appearing at startup on Windows.

- Automatically enter always-on-top Mini mode when the selected source becomes full screen, across supported platforms. Mini mode now also works on macOS and Linux.
- Windows: keep Mini mode above full-screen games while using dictionary popups, and restore its pin if the window manager drops it.

- Windows: fix Hachidori and 10ten startup stalls caused by routing native IPC through the extension HTTP adapter.

- Windows Mini mode now uses the familiar sidebar controls without the source screenshot, with a separate title-bar toggle and an expandable source picker.
- Dictionary extensions can connect to AnkiConnect on another computer using its address on port 8765.

- Windows: add an always-on-top Mini mode from the sidebar button, hide the main window while cropping, and intercept overlay/menu keyboard input before it reaches the game.

- The main window and setup guide start unpinned, so dictionary settings can open above them.
- Dictionary settings buttons appear only once the extension has initialized; they remain
  available while its dictionary data downloads or needs setup.

- Dictionary setup now shows engine startup, dictionary downloads and installation in Settings,
  the sidebar and onboarding. Hachidori and 10ten wait for usable dictionary data before enabling
  lookups; slow first launches no longer immediately show a timeout. Dictionary warnings recover
  automatically and can be dismissed.

- On Windows, switching to Hachidori or 10ten no longer hangs when creating the dictionary's background window. Opening a panel for the first time from the tray also defers window creation safely.

### Added

- Onboarding on macOS asks for Accessibility, after Screen Recording. With it, clicking your
  source brings that exact window to the front, even a game in full screen. It's optional,
  and you can turn it on later in Settings → Sources.
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

- On macOS, when Game Mode is slowing the overlay over a full-screen game, the sidebar says so
  under Show overlay, with a link to Apple's guide to turning it off. Game Mode lets the
  game's window refresh at full speed and every other app's about ten times a second.
- Full-screen apps are recognised: a game in full screen on macOS, or a borderless full-screen
  window. The source card says "Full screen", hovering it no longer covers your screen with a
  preview, and clicking it takes you to the game's Space or desktop.
- A window keeps one crop area for windowed mode and another for full screen, so going full
  screen no longer stretches the crop you drew on the window. Going back restores it.
- The overlay follows a moved window within a tenth of a second instead of a quarter.
- A notebook entry's header shows its picture in a portrait box beside the name, over a dotted
  band tinted by the entry's kind, instead of stretching it across the top. Small pictures stay
  sharp and portraits keep their heads.
- Hovering the source card shows the window's last picture inside its blue outline,
  blurred while a fresh one is taken, then sharp.
- Coming back from Settings, the source card shows its last picture at once instead of waiting
  for a new one.
- The dictionary pop-ups follow Kimochi's Appearance setting (Settings → General) rather than the
  system's, so a dark Kimochi on a light Mac gets dark pop-ups. This includes Yomitan over the
  overlay, which used to always come up light. A pop-up theme set in a dictionary's own settings
  still wins.

- The Yomitan API's Shift-scan feels like Yomitan's own. Pressing Shift looks up the word under the
  pointer without moving the mouse, the pop-up sits above the word (or below it near the top of the
  screen) instead of over the pointer, so you can slide along a line word by word, and it opens
  with the entry instead of a loading state first. The word being defined is selected, as in
  Yomitan, until the pop-up closes. The pointer no longer turns into a crosshair.
- Yomitan API lookups no longer wait behind audio downloads, once Kimochi's helper is updated: in
  the Yomitan API setup (Settings → Dictionary), choose Reinstall, then restart your browser.

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

- On macOS, clicking the source card for a game in full screen now goes to the game's Space,
  even when the game's app has another window on your current desktop (OpenEmu's library).
- Text read from a full-screen app on macOS now lines up with the game. The capture came back
  3% small with an empty band along the top (the window's hidden title bar), so every word
  was drawn below and to the left of where it was read.
- Opening the radial menu with its keyboard shortcut no longer switches away from a full-screen
  game's Space to Kimochi's. Only a controller takes focus from the game, since the game
  would otherwise read its buttons too.
- The overlay's text goes as soon as you switch to another Space, instead of after the slide.
- Switching Spaces on macOS no longer drags the overlay's text across the screen behind a
  full-screen game, or onto another display. The text hides while the Space slides and
  comes back once the game is in place.
- The overlay's word cursor stops on whole words, with every dictionary: 作った, not 作. With the
  Yomitan API it splits words with your Yomitan's own dictionaries; with the others, kanji keep
  the kana of their inflection, and after each lookup the outline fits exactly what Hachidori or
  10ten matched. A word OCR split across two boxes is one stop, and every lookup reads on past the
  end of its box, as the mouse does.

- Stepping through the overlay's words with the keyboard or a controller follows the text in order
  to the end. Background patterns OCR reads as symbols (a carpet's squares) are skipped, as they
  are in the Log, and a stray box can no longer trap the cursor going back and forth between it
  and the end of a line.

- Shift-scan with the Yomitan API works over the overlay, as it does with the other dictionaries:
  hold Shift over the game's text and the word under the pointer is looked up and selected, no
  click needed. It used to look up a whole box's text, and only after a click.
- Switching dictionaries no longer changes the overlay's text: Cloud OCR's separate words used to
  merge into one box per paragraph when the overlay reloaded for the new dictionary.

- Japanese input (IME) works in the Notebook and every other text field: the text you are
  converting stays in place instead of breaking into stray kana. Enter, Escape and the arrow keys
  go to the IME while you are converting, so Escape no longer closes the editor or a dialog, and
  Enter no longer opens a search result.

- Sessions can be reordered by dragging again in **Manage sessions**: the row lifts and follows
  the pointer while the others slide aside. On macOS 26, rows no longer flicker or jump to the
  wrong place mid-drag; every dialog is now centred in a way that avoids the system's drawing bug. From the keyboard, focus a handle, press Space, move with the arrow keys
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

- The Yomitan API's word splitting in the Log: clickable words, furigana and "Split lines into
  words on arrival". Lines in the Log are plain text with every dictionary; Shift-hover looks
  words up.

- Text to speech (read aloud) and Kimochi's own Cloud OCR need a Kimochi account. If Cloud OCR
  is your selected engine and you aren't signed in, scans say so: sign in from Settings → Account
  or choose another engine in Settings → OCR & Overlay. The OwOCR (WebSocket OCR) engine has been removed; if it
  was selected, Kimochi uses the default engine instead.
- Auto-scan is now started from your controller (the gamepad trigger in Settings → OCR &
  Overlay) or a scan shortcut; the keyboard "Trigger keys" option is gone on every platform.
  On macOS, Kimochi no longer needs Accessibility permission, and you can remove it in System
  Settings → Privacy & Security → Accessibility.

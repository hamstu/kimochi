# Changelog

What changed in each release of Kimochi, newest first. Written for the people who use the app:
what they can now do, what behaves differently, what was fixed. The app shows this file in
**What's new** (and once, on its own, after it has updated), and the version's section becomes
the GitHub release's notes, so keep it readable.

Add lines under **Unreleased** as you merge work; `npm run release -- <version>` moves them under
the new version with the date. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Headings inside a version are optional: `### Added`, `### Changed`, `### Fixed`, `### Removed`.

## [Unreleased]

- Fixed: on Linux, including the Steam Deck, Hachidori lookups from the controller or the overlay were slow and often showed nothing, because Kimochi's hidden windows ran their timers once a second.
- Fixed: in Gaming Mode, one D-pad tap could move several words, B could close the pop-up twice, and the hints switched to keyboard keys. Kimochi now reads only the controller while it has it.
- Steam Deck: after Return to game, pressing a volume button no longer brings Kimochi back in front of the game.
- Steam Deck: the back buttons (L4, R4, L5, R5) and trackpad clicks can be bound in Settings → Shortcuts & Controls, and the controller menu now opens with R4 by default, so both sticks stay with your game.
- Steam Deck: setting a crop area works in Gaming Mode. Draw, move and resize the box with your finger, or move its corners with the sticks, then press A to save or B to cancel. Before, the editor could not be used or closed there.
- Fixed: on the Steam Deck's touchscreen, tapping a button that opens a menu (Change source, Crop area, the ⋯ menus) often did nothing, or opened the menu and closed it again at once.
- Fixed: sentence audio recording on Linux AppImages (including Steam Deck), which stopped with a PipeWire error as soon as it started.

## [0.2.0] - 2026-10-27

- First alpha release of Kimochi.

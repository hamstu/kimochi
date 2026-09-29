# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(Tauri 2 on macOS: every window is a WKWebView rendering React. Native window chrome is drawn by the app, not the OS.)

## Product Purpose

Kimochi helps a Japanese learner read games and visual novels in Japanese. It captures a chosen screen or window, OCRs it (on demand or automatically), draws the recognised text over the game, and keeps a running log of lines where words can be looked up, heard, explained, saved to Anki and linked to a per-session notebook of characters, places and terms. Success: the learner stays in the game and the tool never gets in the way of reading.

## Positioning

A reading companion that lives beside the game rather than a separate study app: capture, overlay, transcript, dictionary and notebook are joined in one set of small floating windows.

## Operating Context

- Long reading sessions with a game or VN in the foreground; Kimochi windows (compact remote/controller, Log, Settings, Notebook, source picker, tray popover, dictionary popups) float beside or above it, often pinned on top.
- Windows are small and dense by necessity. They are often inactive while the game has focus, so hover and click-through behaviour for inactive windows matters.
- Japanese text (log lines, dictionary entries) is the primary content; UI chrome is secondary.
- Inputs: OCR (cloud/local server, Tesseract, OwOCR), clipboard, WebSocket texthookers. Dictionaries are Yomitan's, imported through Yomitan's own settings UI.

## Capabilities and Constraints

- macOS 14+ is the only implemented target today, but the app will ship cross-platform (Windows, Linux) later. Design must not depend on macOS-only fonts, vibrancy or native chrome; window chrome is app-drawn and should read as platform-neutral. Tauri transparency currently uses the macOS private API.
- Frontend: React 19, Vite, Tailwind 4, Radix Themes plus Radix primitives, lucide icons. Panels were copied from the Electron app and the Texthooker integration, which is why they use two component styles.
- Yomitan is vendored and hash-verified (`npm run verify`); its distributed files must not be edited. Its popup may only be styled by supported means (such as its custom CSS setting).
- One instance; settings live under `~/Library/Application Support/dev.kimochi.app/`.
- Terminology: Controller / remote, Log, Session, Notebook (entries: characters, places, notes), Source (screen or window), Crop / region, Auto OCR, Overlay.

## Brand Commitments

- Name: Kimochi. Current accent: Radix indigo.
- Aesthetic reference set by the user: the Controller's remote-control window: minimal window shell, aligned full-width selectable rows, quiet dividers, small switches.
- Minimal but attractive; compact and dense; Radix as the component foundation, with shared core components everywhere.
- Appearance: light, dark and system (system by default). A user-adjustable UI scale (medium by default) that scales type and spacing.

## Evidence on Hand

Real product only; no marketing, testimonials or users to cite. The product is currently used by its developer, with a public release planned later.

## Product Principles

1. The game comes first: Kimochi windows stay compact and quiet and never compete with the text being read.
2. Japanese text is the hero; UI chrome recedes.
3. One system: every window, menu and control comes from the same components and type scale.
4. Works while unfocused: hover, cursor and click behaviour stay correct in inactive windows.
5. Ready for others: a public release is planned, so clarity and onboarding matter.

## Accessibility & Inclusion

The UI scale setting is the main accommodation: all type and spacing scale together. Both light and dark themes must hold contrast.

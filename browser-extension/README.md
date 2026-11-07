# Kimochi browser extension

Pick a picture on any web page (a manga page, a game screenshot) and the Kimochi app reads it with
the user's OCR engine and filters. The lines come back with their places and are laid over the
picture, in the overlay's own look, for the browser's dictionary pop-up (Yomitan, 10ten, …) to
read. Kimochi draws nothing itself in this mode, and does no dictionary lookups: the browser's
extensions do.

- `extension/`: the MV3 extension, plain JavaScript with no build step.
  - `background.js`: the service worker. It injects the page script, takes screenshots and
    fetches pictures from any site.
  - `bridge.js`: the WebSocket to the app.
  - `content.js`: the page script. It handles picking, the boxes, the toolbar, and watching the
    picture for changes.
- `test-page/`: a page with Japanese in an `<img>` (with a page turn), a CSS background and a
  `<canvas>`. Serve it (not on 8765, AnkiConnect's port) with `python3 -m http.server 8781 --bind 127.0.0.1 --directory browser-extension/test-page`.

The app side is `src-tauri/src/browser_bridge.rs` and `onBrowserScan` in `ui/overlay.js`. The
protocol is under "Browser bridge" in COMMANDS.md.

## Install for development

1. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and pick
   `browser-extension/extension`. **Settings → Browser Extension** → **Show folder** opens the same
   folder.
2. Run Kimochi. A development build listens on port 27641, the app on 27640, and the extension
   tries both.
3. Click Kimochi in the toolbar (or press Alt+K) and click a picture.

Other Chromium browsers load it the same way, from the same folder:

| Browser | Extensions page | Developer mode |
| --- | --- | --- |
| Edge | `edge://extensions` | switch in the left sidebar |
| Brave | `brave://extensions` | switch at the top right |
| Vivaldi | `vivaldi://extensions` | switch at the top right |
| Opera | `opera://extensions` | switch at the top right |
| Arc | `chrome://extensions` | switch at the top right |

Firefox isn't supported yet.

The manifest's `key` is the Chrome Web Store listing's public key, so an unpacked copy gets the
store's id, `aciakombihkdppgjigibggnmoninegjm`, the only origin the app accepts (`ORIGINS` in
`browser_bridge.rs`). Another store (Edge Add-ons) gives its own id, which has to be added there.
`node browser-extension/pack.mjs` builds the zip the stores take, without the `key`.

## What is read

What you pick is a scope:

- **A picture.** The scope is just that picture. When it slides out of view and another picture
  of about the same size is in its place (a slider's next page), that picture is read instead.
- **A container.** Press ↑ while picking to widen the pick, and ↓ to narrow it again. Each
  picture inside that is mostly in view is read, at most 4 at a time, right to left as manga
  pages run. "In view" accounts for the window, the boxes that clip or scroll around the
  picture, and hidden pictures.

Each picture gets its own boxes, attached to it and clipped to the part that shows. Its reading is
kept, so a picture slid back into view shows its boxes at once, without being read again. Pictures
are read one at a time. A reading that never comes back is given up after 75 s. No picture goes to
Kimochi larger than 4096 px on its long side or 12 megapixels. The picker also finds pictures that
don't take the pointer, as readers that hide their pages under a cover do.

## How a picture is read

- **Images:** the worker fetches the image's own bytes at full resolution (any origin, with the
  host permission), so the whole image is read even when part of it is scrolled away.
- **Canvases and videos:** their pixels are read directly when the page allows it.
- **Anything else, or when that fails:** the visible part is cut from a screenshot of the tab, and
  the boxes are hidden while it is taken.

**Auto** (the toolbar's switch, on by default) reads the picture again when it changes: a new
`src`, a DOM change inside the picked element, a reader that swaps the element, or new pixels in a
canvas or video (polled every 1.5 s and compared by a small fingerprint). After a full page load on
the same site, the worker puts the page script back and it finds the picture in the same place on
the new page (the same path in the page, or the element of the same kind nearest where it was and of
a similar size): a gallery's next image, a reader's next page. A site that changes pages without a page load (it swaps
its content and URL) is followed the same way, without a reload. As a page changes, the old boxes go at
once and the toolbar says a reading is coming. `test-page/gallery/1.html` (page loads) and
`test-page/gallery/app.html` (no page loads) try both.

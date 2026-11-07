# Store listing

What goes into the Chrome Web Store dashboard (and Edge Add-ons, which asks for the same things).
The package is `node browser-extension/pack.mjs` → `browser-extension/dist/kimochi-browser-<version>.zip`.
Images are in this folder: `store-icon-128.png`, `screenshot-1-read.png` … `screenshot-4-auto.png`
(1280×800) and `promo-small-440x280.png`. They're taken from `test-page/store.html?scene=read|look|game|menu`
and `test-page/promo.html` with the real extension running, in a 1280×800 window.

## Package tab

Upload the zip. The manifest's `description` is the store summary (132 characters at most).

## Store listing tab

**Title** (from the manifest): Kimochi

**Summary** (from the manifest):
Read Japanese in pictures on any page, with your dictionary pop-up. Needs the free Kimochi desktop app for Mac, Windows or Linux.

**Category:** Education
**Language:** English

**Description:**

```
Kimochi reads the Japanese in pictures on web pages (manga, game screenshots, signs, comics) and puts the text over the picture, so your pop-up dictionary can look it up.

IMPORTANT: this extension needs the Kimochi desktop app, which does the reading. Kimochi is free for Mac, Windows and Linux: get it at https://kimochiapp.com and start it before using the extension.

HOW IT WORKS
1. Click the Kimochi button in the toolbar (or press Alt+K) and click a picture. Use the arrow keys to pick a bigger or smaller area, such as a whole two-page spread.
2. Kimochi reads it with the OCR model you chose in the app, and the text appears over the picture in the same style as Kimochi's overlay.
3. Hold Shift over the text and look words up with the dictionary you already use: 10ten, Yomitan or Hachidori.
4. Every line goes into your Kimochi Log with its picture, ready to mine to Anki.

FEATURES
• Auto: keeps reading as you turn pages, in readers that slide, swap pictures or load a new page.
• Works in image viewers and lightboxes, and with pictures drawn on a canvas or used as backgrounds.
• Choose the OCR model (Google Lens, Manga OCR, MeikiOCR, PaddleOCR, Apple Live Text, OneOCR or Kimochi's cloud OCR) from the toolbar.
• Sessions: each site gets its own Kimochi session, remembered for next time, and you can pick, create or rename one from the toolbar.
• Matches your Kimochi look: box colour, opacity and light or dark theme come from the app's settings.

PRIVACY
The extension talks only to the Kimochi app on your computer (127.0.0.1). It has no analytics, tracking or ads. What the app does with a picture depends on the OCR model you choose. Details: https://kimochiapp.com/privacy#browser-extension

Kimochi is open source (GPL-3.0): https://github.com/hamstu/kimochi
```

**Images:** store icon `store-icon-128.png`; screenshots 1 to 4 in order; small promo tile
`promo-small-440x280.png`. No marquee.

**Official URL / Homepage:** https://kimochiapp.com
**Support URL:** https://github.com/hamstu/kimochi/issues

## Privacy practices tab

**Single purpose:**
Lets the user pick a picture on a web page and have the Kimochi desktop app on the same computer read the Japanese text in it, then shows that text over the picture so a dictionary extension can look it up.

**Permission justifications:**

- `activeTab`: When the user clicks the toolbar button or presses Alt+K, the extension runs on that tab only, to let them pick a picture and to take a screenshot of the visible tab when the picture can't be downloaded (canvas, CSS backgrounds, cross-origin images).
- `scripting`: Injects the extension's own content script (the picker, the text over the picture and its toolbar) into the tab the user turned it on in, and again after that tab loads its next page when the user has Auto on.
- `storage`: Remembers the user's Auto on/off choice, and, for the open tab only, which area of the page they picked, so reading can carry on after the page reloads.
- Host permission `<all_urls>`: The pictures the user reads can be on any site. The extension needs it to download the picture the user picked from its own address (with the page's cookies, as the page loads it), to screenshot the visible tab while Auto follows a reader without a click, and to carry on in the same tab after the reader loads its next page. It only acts on tabs where the user turned it on.

**Remote code:** No, I am not using remote code. (All code is in the package; the only connection is a local WebSocket to the Kimochi app at 127.0.0.1.)

**Data usage** (what the extension handles, to send to the Kimochi app on the same computer):

- Website content: yes (the pictures the user picks, and the page's title).
- Web history: yes (the address of the page the user turns it on in, so the app can file the lines in the right session).
- Everything else (personally identifiable info, health, financial, authentication, personal communications, location, user activity): no.

Certify all three: not sold to third parties; not used or transferred for purposes unrelated to the item's single purpose; not used or transferred to determine creditworthiness or for lending.

**Privacy policy URL:** https://kimochiapp.com/privacy#browser-extension

## Distribution tab

Free, public, all regions.

## Test instructions (for the reviewer)

```
This extension is the companion to the Kimochi desktop app and does nothing without it. Without the app, its toolbar says "Kimochi isn't running" and offers a "Get the app" link.

To test:
1. Download and install Kimochi (free) from https://kimochiapp.com (macOS, Windows or Linux; also at https://github.com/hamstu/kimochi/releases). Start it. Its default OCR model, Google Lens, needs no download.
2. In Chrome, open any page with a picture that has Japanese text in it (a manga page, a game screenshot, a photo of a sign).
3. Click the Kimochi toolbar button (or press Alt+K), then click the picture.
4. After a moment the text appears over the picture and the toolbar says how many lines were found. Hold Shift over the text: it becomes selectable, and a dictionary extension such as 10ten Japanese Reader shows its pop-up.
5. The lines also appear in the Kimochi app's Log.
```

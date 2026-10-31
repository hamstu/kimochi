# Engine icons

The picture beside each engine's name in the engine choosers (Settings → OCR & Overlay, Settings →
Dictionary) and onboarding's dictionary step, drawn by `frontend/components/EngineIcon.tsx` at
1.25rem (20 px at the default interface size). Licences and trademarks are in the repository's
`NOTICE` ("Engine icons").

| File | Engine | Source |
| --- | --- | --- |
| `yomitan.svg` | Built-in Yomitan | Yomitan's `ext/images/yomitan-icon.svg` (yomidevs/yomitan, GPL-3.0-or-later), with a `viewBox` added |
| `yomitan-api.svg` | Yomitan API | The Yomitan icon with a `{ }` badge in the bottom-right corner: white braces with a thin near-black outline, on the icon's own gradient (the glyph's last bar is masked out under it) |
| `hachidori.png` | Hachidori | `icons/hachidori-128.png` (bee-san/hachidori, GPL-3.0-or-later), resized to 64 px for 2x |
| `tenten.svg` | 10ten | `images/10ten.svg` (birchill/10ten-ja-reader, GPL-3.0-or-later), with a faint light edge so the dark tile shows on dark grounds |
| `google-lens.svg` | Google Lens | Google's Lens icon (Wikimedia Commons, `File:Google_Lens_Icon.svg`), viewBox cropped to the artwork |
| `kimochi-cloud.svg` | Cloud OCR | Kimochi's キ on the indigo tile, from `branding/` (no corner brackets: they blur at this size) |
| `windows.svg` | OneOCR | The four-pane Windows logo, drawn here |

Engines with no logo of their own are drawn in code, in a neutral tile that follows the theme:
Apple Live Text with lucide's `ScanText` (Apple's logo is not used), PaddleOCR with a paddle drawn
for Kimochi in lucide's style (the project's marks are wordmarks, unreadable at this size), MeikiOCR
with an "M" and Manga OCR with 漫 (neither project publishes a logo).

Keep the files small (the test allows 8 KB each), give every SVG a `viewBox`, and use no
`<text>`: the pictures must not depend on an installed font. Check new ones at 20 and 40 px on
both a light and a dark ground.

# Kimochi icon

A white katakana キ (ki) framed by four corner brackets, on a Radix indigo squircle (`#3e63dd`, from a step lighter at the top to a step deeper at the bottom, with a faint top sheen). The brackets read as a camera viewfinder or targeting reticle, a nod to the OCR capture. The glyph is Hiragino Sans W8, already converted to outlines, so no SVG here depends on an installed font.

The brackets are set by `RETICLE` in `compose.mjs`, as fractions of the tile width: `half` 0.335 (sets the inset from the tile edge), `arm` 0.115, `stroke` 0.046 and `opacity` 0.82. The キ is 0.44 of the tile (`GLYPH`). This weight keeps each bracket a solid line of about 1.2px at a 32px icon; the earlier thinner brackets broke up at that size. At 16px the brackets soften into texture and the キ carries the icon.

## Files

| File | What it is | Used for |
| --- | --- | --- |
| `icon.svg` | Squircle filling the 1024 canvas, no margin or shadow | Website hero (`site/public/icon.svg`), OG image |
| `icon-macos.svg` | 824px squircle centred in the 1024 canvas (100px margin) with a soft drop shadow | `src-tauri/icons/icon.icns` |
| `icon-square.svg` | Full-bleed square. Glyph and brackets scale with the full 1024 width, so they are ~24% larger than on the macOS tile | `icon.ico`, Linux PNGs, `Square*Logo.png`, `StoreLogo.png`, apple-touch-icon |
| `favicon.svg` | Bare キ, no brackets (at 16px they would squeeze the glyph to ~7px). Uses `currentColor`. Standalone it uses indigo `#3e63dd` in light mode and `#9eb1ff` in dark mode. If you inline it in HTML, delete its `<style>` so it inherits colour from the page | `site/public/favicon.svg` |
| `tray-template.svg` | 16pt black キ for the macOS menu bar, no brackets for the same reason | `tray-template.png`, `tray-template@2x.png` |
| `sketches/*.svg` | `0-final-macos` and `0-final-square` are copies of the shipped design. The rest are the alternatives that were considered (vertical gradient without brackets, diagonal gradient, dark ground, bare glyph). Each has a `.png` preview, and `contact-sheet.png` shows them all | Previews only |
| `steam/*.svg`, `steam-library.mjs` | Steam library artwork: portrait capsule (600×900), wide capsule (920×430), hero (1920×620, no text) and transparent logo, built from `icon.svg` plus the Figtree / Noto Sans JP wordmark as outlines (OFL, LICENSE-OFL.txt). `steam-library.mjs` writes the SVGs | `resources/steam-library/*.png` (installed into Steam's grid folder by Add to Steam) and the welcome step's `frontend/welcome/assets/steam-capsule.png`, via `npm run icons` (or `npm run icons -- --steam` for these alone) |
| `compose.mjs` | Writes all of the SVGs above from shared parameters: squircle geometry, colours, glyph size and optical centring | Optional |

## Regenerating

```sh
npm run icons                # SVG masters -> every PNG/ICO/ICNS + site/public + previews
node branding/compose.mjs    # optional: rebuild the SVG masters from parameters first
```

To change the icon, edit the SVGs directly and run `npm run icons`. You can also change `compose.mjs` and run both commands. Running `compose.mjs` overwrites any edits made by hand to the SVGs. To swap the glyph or font, extract new outlines with fontkit (`font.layout('キ').glyphs[0].path.transform(1,0,0,-1,0,0).toSVG()`) and paste them into `KI`. Record the bbox and the ink centroid too; `placeGlyph` uses them for optical centring.

`scripts/icons.mjs` does this:

1. Rasterises the masters at 1024px with `@resvg/resvg-js`. System fonts are disabled, and the script refuses any SVG that contains `<text>`.
2. Runs `tauri icon` twice, each time into a temp dir:
   - From `icon-square.png`, it keeps every `*.png` and `icon.ico`.
   - From `icon-macos.png`, it keeps only `icon.icns`.

   The iOS/Android sets that the CLI also emits are thrown away.
3. Writes the tray template PNGs, `site/public/{icon.svg,favicon.svg,apple-touch-icon.png (180),og-icon.png (512)}`, the sketch previews and a contact sheet. The contact sheet shows each sketch at 256/64/32/16px on light and dark grounds.

## What the platforms expect (researched Oct 2026)

- **`tauri icon`** takes one square PNG or SVG (or a JSON manifest) and writes `icon.icns`, `icon.ico` (16–256 layers, 32px first), `32x32.png`, `64x64.png`, `128x128.png`, `128x128@2x.png`, `icon.png` (512), the `Square{30..310}x…Logo.png`/`StoreLogo.png` set (for AppX/MS Store, unused by the current bundles), plus iOS/Android sets. It copies the source as is: it **does not mask, round, pad or shadow** anything for macOS. Feeding it a full-bleed square gives an oversized square tile in the Dock, which is why there are two sources ([Tauri icons docs](https://v2.tauri.app/develop/icons/), [juejin write-up of the oversized-icns problem](https://juejin.cn/post/7436221709847724071)).
- **macOS** applies no mask to `.icns`, so the shape has to be drawn in the source. Apple's Big Sur grid puts an 824×824 continuous-corner squircle (radius ≈ 185) centred in the 1024 canvas, leaving ~10% around it for the shadow. The shadow is soft, about 10px down, 10px blur and 30% black. `squircle()` uses the reverse-engineered `UIBezierPath` continuous-corner curve, not a circular-arc rounded rect.
- **macOS 26 Tahoe** puts legacy icons into a grey squircle ("icon jail") when their pixels poke outside its expected shape ([heise](https://heise.de/-11075561), [Rogue Amoeba](https://weblog.rogueamoeba.com/2026/06/26/free-the-icons/)). Matching the 824/100 grid is the best defence. If Tahoe still jails the app, the next steps are to drop the shadow filter in `icon-macos.svg` or to ship an Icon Composer `.icon` asset.
- **Dev mode on macOS** uses the `.icns` for the Dock (`tauri-codegen` prefers `.icns` there). The window icon on Linux comes from the first `.png` in `bundle.icon`, which is `icon.png`, the square variant.
- **Windows** expects a full-bleed square `.ico`; the system adds no rounding or plate. **Linux** expects square RGBA PNGs (32/128/256/512) and themes may mask them. Both use `icon-square`. Glyph and brackets come out larger there, which helps them hold up at 16–24px.

## Tray icon

`src-tauri/src/tray.rs` embeds `resources/app-icon-Template@2x.png` (32×32, the old を disc) with `include_bytes!` and marks it `icon_as_template(true)` on macOS. `branding/tray-template@2x.png` is a drop-in replacement: a 32px black キ on transparent. To switch, copy it over `resources/app-icon-Template@2x.png`, or point `TEMPLATE_ICON` at the new file. The 1x file is there if you later load both scales. Windows and Linux trays draw the PNG as is, so a black glyph will vanish on a dark taskbar. For those, consider a `#[cfg(not(target_os = "macos"))]` icon that uses `src-tauri/icons/32x32.png`.

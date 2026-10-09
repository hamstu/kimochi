#!/usr/bin/env node
// Regenerates every app icon from the SVG masters in branding/.
//
//   npm run icons
//
// 1. Rasterises the masters to 1024px PNGs with resvg (system fonts off, so a stray
//    <text> would render blank rather than silently depend on this machine's fonts).
// 2. Runs `tauri icon` twice into temp dirs: once from the full-bleed square (ico,
//    Linux/Windows PNGs, Store logos) and once from the macOS squircle, keeping only
//    its icon.icns. `tauri icon` takes the source as is (no masking, padding or
//    rounding), so macOS needs a source with the squircle and margins already drawn,
//    while Windows and Linux want the full square.
// 3. Writes the menu bar template PNGs, the website icons and the sketch previews.
import { Resvg } from "@resvg/resvg-js";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const branding = join(root, "branding");
const sketches = join(branding, "sketches");
const tauriIcons = join(root, "src-tauri", "icons");
const sitePublic = join(root, "site", "public");

const rel = (p) => p.slice(root.length + 1);

function render(svgPath, size) {
  const svg = readFileSync(svgPath, "utf8");
  if (/<text[\s>]/.test(svg)) throw new Error(`${rel(svgPath)} contains <text>; convert glyphs to outlines`);
  return new Resvg(svg, {
    fitTo: { mode: "width", value: size },
    font: { loadSystemFonts: false },
    background: "rgba(0,0,0,0)",
  })
    .render()
    .asPng();
}

function write(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  console.log(`  ${rel(path)}`);
}

function tauriIcon(sourcePng) {
  const out = mkdtempSync(join(tmpdir(), "kimochi-icons-"));
  try {
    // The CLI logs every file it writes (incl. iOS/Android sets) to stderr; keep it
    // quiet unless it fails.
    execFileSync("npx", ["--no-install", "tauri", "icon", sourcePng, "--output", out], { cwd: root, stdio: "pipe" });
  } catch (err) {
    process.stderr.write(String(err.stderr ?? ""));
    throw err;
  }
  return out;
}

console.log("Rasterising masters");
const macPng = join(branding, "icon-macos.png");
const squarePng = join(branding, "icon-square.png");
write(macPng, render(join(branding, "icon-macos.svg"), 1024));
write(squarePng, render(join(branding, "icon-square.svg"), 1024));
write(join(branding, "icon.png"), render(join(branding, "icon.svg"), 1024));

console.log("Menu bar template (16pt)");
write(join(branding, "tray-template.png"), render(join(branding, "tray-template.svg"), 16));
write(join(branding, "tray-template@2x.png"), render(join(branding, "tray-template.svg"), 32));

console.log("Tauri bundle icons");
const fromSquare = tauriIcon(squarePng);
const fromMac = tauriIcon(macPng);
try {
  // Desktop outputs only; `tauri icon` also emits android/ and ios/ trees we don't ship.
  for (const name of readdirSync(fromSquare)) {
    if (!/\.(png|ico)$/.test(name)) continue;
    copyFileSync(join(fromSquare, name), join(tauriIcons, name));
    console.log(`  ${rel(join(tauriIcons, name))}`);
  }
  copyFileSync(join(fromMac, "icon.icns"), join(tauriIcons, "icon.icns"));
  console.log(`  ${rel(join(tauriIcons, "icon.icns"))} (macOS squircle)`);
} finally {
  rmSync(fromSquare, { recursive: true, force: true });
  rmSync(fromMac, { recursive: true, force: true });
}

console.log("Website");
mkdirSync(sitePublic, { recursive: true });
copyFileSync(join(branding, "icon.svg"), join(sitePublic, "icon.svg"));
console.log(`  ${rel(join(sitePublic, "icon.svg"))}`);
copyFileSync(join(branding, "favicon.svg"), join(sitePublic, "favicon.svg"));
console.log(`  ${rel(join(sitePublic, "favicon.svg"))}`);
// iOS rounds apple-touch-icon itself, so it gets the full square.
write(join(sitePublic, "apple-touch-icon.png"), render(join(branding, "icon-square.svg"), 180));
write(join(sitePublic, "og-icon.png"), render(join(branding, "icon.svg"), 512));

console.log("Sketch previews");
const previews = [];
for (const name of readdirSync(sketches).filter((n) => n.endsWith(".svg")).sort()) {
  const png = render(join(sketches, name), 512);
  write(join(sketches, name.replace(/\.svg$/, ".png")), png);
  previews.push({ name: basename(name, ".svg"), svg: join(sketches, name) });
}

// Contact sheet: each sketch at 256/64/32/16 px on light and dark grounds, so the
// small sizes (Dock in lists, taskbar, tabs) can be judged next to the large one.
const sizes = [256, 64, 32, 16];
const rowH = 300;
const colW = 256 + 64 + 32 + 16 + 5 * 24;
const sheetW = colW * 2;
const sheetH = rowH * previews.length;
const dataUri = (svgPath, px) => `data:image/png;base64,${render(svgPath, px).toString("base64")}`;
let cells = "";
previews.forEach((p, i) => {
  const y0 = i * rowH;
  for (const [g, ground] of [
    [0, "#ffffff"],
    [1, "#111113"],
  ]) {
    const x0 = g * colW;
    cells += `<rect x="${x0}" y="${y0}" width="${colW}" height="${rowH}" fill="${ground}"/>`;
    let x = x0 + 24;
    for (const s of sizes) {
      // Render at the target size so the sheet shows real small-size rasterisation.
      cells += `<image x="${x}" y="${y0 + 22 + (256 - s) / 2}" width="${s}" height="${s}" href="${dataUri(p.svg, s)}"/>`;
      x += s + 24;
    }
  }
  cells += `<text x="12" y="${y0 + rowH - 8}" font-family="Helvetica" font-size="13" fill="#80838d">${p.name}</text>`;
});
const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${sheetW}" height="${sheetH}">${cells}</svg>`;
write(
  join(sketches, "contact-sheet.png"),
  new Resvg(sheet, { font: { loadSystemFonts: true } }).render().asPng(),
);

if (!existsSync(join(tauriIcons, "icon.icns"))) throw new Error("icon.icns missing after generation");
console.log("Done.");

// Writes the Steam library artwork masters (branding/steam/*.svg) from the shipped icon
// (branding/icon.svg) and the Kimochi wordmark. `npm run icons` rasterises them into
// resources/steam-library/ (what Settings / the welcome guide install into Steam's grid
// folder) and the welcome guide's preview.
//
//   node branding/steam-library.mjs && npm run icons -- --steam
//
// Steam's sizes: portrait capsule 600×900 (`<appid>p.png`, the library grid), wide capsule
// 920×430 (`<appid>.png`, recent games and search), hero 1920×620 (`<appid>_hero.png`, the
// game page banner; no text, Steam lays the logo over its lower left) and a transparent logo
// (`<appid>_logo.png`).
//
// The wordmark is Figtree (weight 700) and the Japanese 気持ち Noto Sans JP (weight 500), both
// OFL-licensed (LICENSE-OFL.txt) and already bundled with the app. Their outlines were extracted
// once from the @fontsource-variable packages with fontkit (woff2 decompressed with wawoff2,
// `getVariation({wght})`, y flipped), so no SVG here depends on an installed font. Units are
// font units: 1000 per em, baseline at y = 0.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const WORDMARK = {
  d: "M76 0L76 -700L211 -700L211 -424L470 -700L647 -700L351 -384L658 0L489 0L262 -288L211 -234L211 0ZM731 0L731 -500L863 -500L863 0ZM797 -581Q767 -581 744 -603.5Q721 -626 721 -657Q721 -688 744 -710.5Q767 -733 797 -733Q828 -733 850.5 -710.5Q873 -688 873 -657Q873 -626 850.5 -603.5Q828 -581 797 -581ZM985 0L985 -500L1109 -500L1115 -435Q1138 -473 1174 -492.5Q1210 -512 1254 -512Q1315 -512 1356.5 -486Q1398 -460 1417 -406Q1439 -457 1479 -484.5Q1519 -512 1572 -512Q1660 -512 1706 -456.5Q1752 -401 1752 -286L1752 0L1620 0L1620 -256Q1620 -307 1609 -335Q1598 -363 1579 -375.5Q1560 -388 1534 -388Q1486 -389 1460 -357Q1434 -325 1434 -262L1434 0L1302 0L1302 -256Q1302 -307 1291.5 -335Q1281 -363 1261.5 -375.5Q1242 -388 1216 -388Q1168 -389 1142.5 -357Q1117 -325 1117 -262L1117 0ZM2091.8 12Q2015.8 12 1956.3 -21.5Q1896.8 -55 1863.3 -114Q1829.8 -173 1829.8 -250Q1829.8 -327 1862.8 -386Q1895.8 -445 1954.8 -478.5Q2013.8 -512 2089.8 -512Q2166.8 -512 2225.8 -478.5Q2284.8 -445 2317.8 -386Q2350.8 -327 2350.8 -250Q2350.8 -173 2317.8 -114Q2284.8 -55 2226.3 -21.5Q2167.8 12 2091.8 12ZM2091.8 -110Q2128.8 -110 2156.8 -128Q2184.8 -146 2200.3 -177.5Q2215.8 -209 2215.8 -250Q2215.8 -291 2199.8 -322.5Q2183.8 -354 2155.3 -372Q2126.8 -390 2089.8 -390Q2053.8 -390 2025.3 -372Q1996.8 -354 1980.8 -322.5Q1964.8 -291 1964.8 -250Q1964.8 -209 1980.8 -177.5Q1996.8 -146 2025.8 -128Q2054.8 -110 2091.8 -110ZM2679.2 12Q2601.2 12 2540.2 -21.5Q2479.2 -55 2445.2 -114.5Q2411.2 -174 2411.2 -250Q2411.2 -327 2445.2 -386Q2479.2 -445 2539.2 -478.5Q2599.2 -512 2677.2 -512Q2752.2 -512 2814.2 -475Q2876.2 -438 2904.2 -368L2780.2 -324Q2766.2 -353 2736.7 -370.5Q2707.2 -388 2671.2 -388Q2634.2 -388 2606.2 -370.5Q2578.2 -353 2562.2 -322Q2546.2 -291 2546.2 -250Q2546.2 -209 2562.2 -178.5Q2578.2 -148 2607.2 -130Q2636.2 -112 2673.2 -112Q2709.2 -112 2738.7 -131Q2768.2 -150 2782.2 -181L2907.2 -137Q2878.2 -66 2816.7 -27Q2755.2 12 2679.2 12ZM2984.8 0L2984.8 -700L3116.8 -700L3116.8 -436Q3141.8 -473 3178.8 -492.5Q3215.8 -512 3261.8 -512Q3321.8 -512 3363.3 -488Q3404.8 -464 3426.8 -413.5Q3448.8 -363 3448.8 -283L3448.8 0L3316.8 0L3316.8 -256Q3316.8 -307 3304.8 -335Q3292.8 -363 3271.8 -375.5Q3250.8 -388 3222.8 -388Q3171.8 -389 3144.3 -357Q3116.8 -325 3116.8 -262L3116.8 0ZM3561.4 0L3561.4 -500L3693.4 -500L3693.4 0ZM3627.4 -581Q3597.4 -581 3574.4 -603.5Q3551.4 -626 3551.4 -657Q3551.4 -688 3574.4 -710.5Q3597.4 -733 3627.4 -733Q3658.4 -733 3680.9 -710.5Q3703.4 -688 3703.4 -657Q3703.4 -626 3680.9 -603.5Q3658.4 -581 3627.4 -581Z",
  bbox: [76, -733, 3703.4, 12],
};

const WORDMARK_JA = {
  d: "M244 -742L928 -742L928 -663L244 -663ZM255 -597L835 -597L835 -520L255 -520ZM139 -453L730 -453L730 -372L139 -372ZM246 -847L346 -826Q309 -708 249.5 -607Q190 -506 118 -439Q109 -448 93 -459.5Q77 -471 60.5 -482Q44 -493 31 -500Q105 -559 160.5 -650.5Q216 -742 246 -847ZM506 -360L597 -330Q545 -236 472 -156Q399 -76 312 -13Q225 50 132 96Q124 86 112 72Q100 58 86 44.5Q72 31 61 22Q156 -17 240 -74Q324 -131 392.5 -203.5Q461 -276 506 -360ZM697 -453L794 -453Q794 -358 797 -277.5Q800 -197 809 -136.5Q818 -76 834 -42Q850 -8 876 -8Q889 -9 893.5 -47Q898 -85 899 -148Q913 -132 931 -116Q949 -100 963 -90Q960 -28 950.5 11Q941 50 922 67.5Q903 85 869 85Q812 85 778 44.5Q744 4 727 -68.5Q710 -141 704 -239Q698 -337 697 -453ZM153 -261L221 -323Q277 -293 338 -256Q399 -219 457 -178Q515 -137 565.5 -97Q616 -57 649 -21L574 50Q542 15 494 -26Q446 -67 389 -109Q332 -151 271 -190.5Q210 -230 153 -261ZM1409 -721L1918 -721L1918 -635L1409 -635ZM1372 -342L1958 -342L1958 -255L1372 -255ZM1361 -526L1965 -526L1965 -439L1361 -439ZM1619 -840L1709 -840L1709 -480L1619 -480ZM1749 -456L1840 -456L1840 -22Q1840 16 1830.5 36.5Q1821 57 1796 69Q1772 79 1733 81.5Q1694 84 1639 84Q1636 64 1628 38Q1620 12 1611 -7Q1649 -5 1684 -4.5Q1719 -4 1730 -5Q1741 -6 1745 -9.5Q1749 -13 1749 -23ZM1437 -196L1512 -238Q1533 -212 1555.5 -181Q1578 -150 1596.5 -120.5Q1615 -91 1625 -66L1545 -18Q1536 -43 1518.5 -73.5Q1501 -104 1480 -136.5Q1459 -169 1437 -196ZM1025 -323Q1084 -338 1168.5 -362Q1253 -386 1339 -412L1352 -326Q1273 -302 1193 -277Q1113 -252 1047 -232ZM1040 -648L1346 -648L1346 -560L1040 -560ZM1162 -843L1249 -843L1249 -25Q1249 11 1241 31Q1233 51 1212 62Q1193 73 1161 77Q1129 81 1081 80Q1079 62 1072 36.5Q1065 11 1056 -8Q1086 -7 1111 -7Q1136 -7 1145 -7Q1154 -7 1158 -11Q1162 -15 1162 -25ZM2436 -789Q2429 -767 2424.5 -743Q2420 -719 2415 -697Q2411 -673 2404 -639.5Q2397 -606 2388.5 -567.5Q2380 -529 2371 -490Q2362 -451 2352 -415.5Q2342 -380 2332 -352Q2396 -392 2461 -409.5Q2526 -427 2599 -427Q2680 -427 2737.5 -401.5Q2795 -376 2827 -330Q2859 -284 2859 -222Q2859 -142 2820.5 -86Q2782 -30 2712 1.5Q2642 33 2545.5 42Q2449 51 2331 39L2304 -62Q2389 -50 2469.5 -51Q2550 -52 2614 -69.5Q2678 -87 2716 -124Q2754 -161 2754 -220Q2754 -271 2711.5 -306.5Q2669 -342 2588 -342Q2500 -342 2424 -312Q2348 -282 2300 -223Q2292 -212 2285 -201.5Q2278 -191 2271 -178L2177 -211Q2206 -267 2230 -336Q2254 -405 2272.5 -475.5Q2291 -546 2303 -606Q2315 -666 2319 -704Q2323 -731 2324.5 -751.5Q2326 -772 2324 -794ZM2109 -666Q2152 -659 2206 -654Q2260 -649 2306 -649Q2354 -649 2412.5 -652Q2471 -655 2535 -661Q2599 -667 2663.5 -676.5Q2728 -686 2788 -699L2790 -603Q2739 -595 2677 -587Q2615 -579 2550 -572.5Q2485 -566 2422 -562.5Q2359 -559 2307 -559Q2253 -559 2203 -561.5Q2153 -564 2109 -568Z",
  bbox: [31, -847, 2859, 96],
};
const C = {
  accent: "#3e63dd", // Radix indigo 9, the app accent
  deep: "#2c4cbf",
  night: "#17205a", // the ground's dark end: indigo 9 pulled most of the way to black
  ink: "#ffffff",
  inkJa: "#c6d2ff", // indigo 4-ish on the dark ground, a step behind the wordmark
};

const r = (n) => Math.round(n * 100) / 100;
const svg = (w, h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n${body}\n</svg>\n`;

// The shipped icon, nested as its own 1024 viewport. Each use gets its own id prefix.
const ICON = readFileSync(join(here, "icon.svg"), "utf8")
  .replace(/^[\s\S]*?<svg[^>]*>/, "")
  .replace(/<\/svg>\s*$/, "");
const KI_PATH = ICON.match(/d="(M358 [^"]+)"/)?.[1];
if (!KI_PATH) throw new Error("branding/icon.svg: キ outline not found");
let uses = 0;
function icon(x, y, size) {
  const id = `i${++uses}`;
  const body = ICON.replace(/\bk-/g, `${id}-`);
  return `  <svg x="${r(x)}" y="${r(y)}" width="${r(size)}" height="${r(size)}" viewBox="0 0 1024 1024">${body}</svg>`;
}

/** A glyph run (font units) scaled to `width`, its ink box's left edge at x, baseline at y. */
function run(glyphs, x, baseline, width, attrs) {
  const [x0, , x1] = glyphs.bbox;
  const s = width / (x1 - x0);
  return `  <path transform="translate(${r(x - x0 * s)} ${r(baseline)}) scale(${r(s * 10000) / 10000})" d="${glyphs.d}" ${attrs}/>`;
}
/** The rendered height of a run at `width` (cap/ascender top to baseline, ignoring descent). */
const capHeight = (glyphs, width) => (-glyphs.bbox[1] / (glyphs.bbox[2] - glyphs.bbox[0])) * width;

/** The dark indigo ground: deep at one corner, the app indigo glowing behind the mark. */
function ground(w, h, { glow: [gx, gy, gr], id = "g", to = [w * 0.35, h] }) {
  return [
    `  <defs>`,
    `    <linearGradient id="${id}-ground" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${r(to[0])}" y2="${r(to[1])}">`,
    `      <stop offset="0" stop-color="${C.deep}"/>`,
    `      <stop offset="1" stop-color="${C.night}"/>`,
    `    </linearGradient>`,
    `    <radialGradient id="${id}-glow" gradientUnits="userSpaceOnUse" cx="${r(gx)}" cy="${r(gy)}" r="${r(gr)}">`,
    `      <stop offset="0" stop-color="${C.accent}" stop-opacity="0.75"/>`,
    `      <stop offset="1" stop-color="${C.accent}" stop-opacity="0"/>`,
    `    </radialGradient>`,
    `    <filter id="${id}-lift" x="-20%" y="-20%" width="140%" height="160%">`,
    `      <feDropShadow dx="0" dy="${r(h * 0.01)}" stdDeviation="${r(h * 0.018)}" flood-color="#0b1033" flood-opacity="0.45"/>`,
    `    </filter>`,
    `  </defs>`,
    `  <rect width="${w}" height="${h}" fill="url(#${id}-ground)"/>`,
    `  <rect width="${w}" height="${h}" fill="url(#${id}-glow)"/>`,
  ].join("\n");
}

/** An oversized, faint キ: the icon's glyph as texture, cropped by the frame. */
function ghost(cx, cy, height, opacity) {
  // The outline's ink box is about 871 × 917 font units around (507, -375).
  const s = height / 917;
  return `  <path transform="translate(${r(cx - 507 * s)} ${r(cy + 375 * s)}) scale(${r(s * 10000) / 10000})" d="${KI_PATH}" fill="#fff" fill-opacity="${opacity}"/>`;
}

/** The icon's four corner brackets, framing a region (the OCR viewfinder, at frame scale). */
function brackets(x, y, w, h, arm, stroke, opacity) {
  const [l, t, rr, b] = [x, y, x + w, y + h].map(r);
  const d = [
    `M${l} ${r(t + arm)}V${t}H${r(l + arm)}`,
    `M${r(rr - arm)} ${t}H${rr}V${r(t + arm)}`,
    `M${rr} ${r(b - arm)}V${b}H${r(rr - arm)}`,
    `M${r(l + arm)} ${b}H${l}V${r(b - arm)}`,
  ].join(" ");
  return `  <path d="${d}" fill="none" stroke="#fff" stroke-opacity="${opacity}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

/** Icon above the wordmark, centred on cx: the portrait capsule's lockup. */
function stacked(cx, top, iconSize, wordWidth, filter) {
  const wordTop = top + iconSize + iconSize * 0.3;
  const wordCap = capHeight(WORDMARK, wordWidth);
  const jaWidth = wordWidth * 0.42;
  const jaBase = wordTop + wordCap + jaWidth * 0.34 + capHeight(WORDMARK_JA, jaWidth) * 0.9;
  return [
    `  <g filter="${filter}">`,
    icon(cx - iconSize / 2, top, iconSize),
    run(WORDMARK, cx - wordWidth / 2, wordTop + wordCap, wordWidth, `fill="${C.ink}"`),
    `  </g>`,
    run(WORDMARK_JA, cx - jaWidth / 2, jaBase, jaWidth, `fill="${C.inkJa}"`),
  ].join("\n");
}

/** Icon beside the wordmark, vertically centred on cy: the wide capsule and logo lockup. */
function beside(x, cy, iconSize, wordWidth, { ja = true, filter = "" } = {}) {
  const wordX = x + iconSize * 1.22;
  const wordCap = capHeight(WORDMARK, wordWidth);
  const jaWidth = wordWidth * 0.36;
  const jaCap = capHeight(WORDMARK_JA, jaWidth);
  const gap = wordCap * 0.42;
  const block = ja ? wordCap + gap + jaCap : wordCap;
  const top = cy - block / 2;
  return [
    `  <g${filter ? ` filter="${filter}"` : ""}>`,
    icon(x, cy - iconSize / 2, iconSize),
    run(WORDMARK, wordX, top + wordCap, wordWidth, `fill="${C.ink}"`),
    ja ? run(WORDMARK_JA, wordX + wordWidth * 0.012, top + wordCap + gap + jaCap, jaWidth, `fill="${C.inkJa}"`) : "",
    `  </g>`,
  ].filter(Boolean).join("\n");
}

const files = {};

// Portrait capsule, the library grid tile.
files["capsule.svg"] = svg(
  600,
  900,
  [
    ground(600, 900, { glow: [300, 360, 420] }),
    ghost(520, 840, 560, 0.04),
    brackets(44, 44, 512, 812, 70, 7, 0.22),
    stacked(300, 220, 236, 356, "url(#g-lift)"),
  ].join("\n"),
);

// Wide capsule: recent games, search results, the Desktop Mode library.
files["wide.svg"] = svg(
  920,
  430,
  [
    ground(920, 430, { glow: [270, 215, 420] }),
    ghost(840, 300, 520, 0.04),
    brackets(28, 28, 864, 374, 54, 6, 0.22),
    beside(132, 215, 176, 420, { filter: "url(#g-lift)" }),
  ].join("\n"),
);

// Hero: the game page banner. No text: Steam places the logo over its lower left, so the
// left two thirds stay calm and the mark's texture sits right.
files["hero.svg"] = svg(
  1920,
  620,
  [
    ground(1920, 620, { glow: [1440, 310, 820], to: [1920, 620] }),
    ghost(1440, 330, 900, 0.045),
    brackets(1150, 70, 580, 480, 92, 10, 0.3),
  ].join("\n"),
);

// Logo: transparent, laid over the hero by Steam.
files["logo.svg"] = svg(
  1180,
  400,
  [
    `  <defs>`,
    `    <filter id="l-lift" x="-10%" y="-20%" width="120%" height="150%">`,
    `      <feDropShadow dx="0" dy="6" stdDeviation="10" flood-color="#0b1033" flood-opacity="0.5"/>`,
    `    </filter>`,
    `  </defs>`,
    beside(24, 200, 300, 760, { filter: "url(#l-lift)" }),
  ].join("\n"),
);

for (const [name, content] of Object.entries(files)) {
  const out = join(here, "steam", name);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, content);
  console.log(`wrote branding/steam/${name}`);
}

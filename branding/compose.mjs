// Writes the Kimochi icon SVG masters (and the comparison sketches) from a few
// parameters, so the squircle, gradient and glyph placement stay consistent across
// variants. The SVGs it writes are the real source of truth for `npm run icons`;
// hand-edit them freely, but rerunning this script overwrites those edits.
//
//   node branding/compose.mjs
//
// The キ outline is Hiragino Sans W8 (macOS system font), extracted once with fontkit
// (`font.layout('キ').glyphs[0].path`, y flipped) so no SVG depends on an installed
// font. Units are font units: 1000 per em, baseline at y = 0, glyph above it.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const KI = {
  W8: {
    d: "M358 -641L219 -620C149 -609 116 -605 72 -604L99 -433C140 -444 163 -448 248 -461L386 -483L409 -357L218 -327C158 -317 116 -313 75 -311L102 -141C165 -157 170 -158 239 -169L437 -200L463 -56C477 20 481 49 481 83L671 52C659 14 657 4 641 -82L613 -227L802 -256C886 -268 886 -268 943 -274L913 -443C871 -430 838 -423 769 -412L584 -384L560 -510L716 -534C824 -550 824 -550 858 -553L830 -721C786 -708 758 -703 687 -692L531 -668L520 -723C512 -769 507 -803 506 -834L322 -806C332 -777 337 -756 348 -693Z",
    bbox: [72, -834, 943, 83],
    centroid: [491.0, -403.1],
  },
  W7: {
    d: "M373 -630L217 -606C144 -595 126 -593 82 -592L105 -446C160 -459 171 -462 241 -473L397 -497L423 -350L213 -317C147 -307 122 -304 81 -303L105 -158C146 -170 169 -174 231 -184L447 -218L475 -65C487 -1 493 46 494 75L656 48C643 8 638 -14 624 -92L596 -241L799 -272C895 -288 895 -288 930 -290L905 -434C864 -421 837 -415 771 -405L571 -373L544 -519L720 -547C802 -559 802 -559 846 -563L822 -707C783 -695 760 -690 695 -680L519 -653L507 -712C497 -766 493 -795 492 -827L335 -802C347 -770 347 -770 362 -687Z",
    bbox: [81, -827, 930, 75],
    centroid: [489.6, -404.3],
  },
};

const C = {
  accent: "#3e63dd", // Radix indigo 9
  accentHover: "#3358d4", // indigo 10
  light: "#5a7ce6", // a step lighter than indigo 9, for the top of the gradient
  deep: "#2c4cbf", // a step deeper than indigo 10, for the bottom
  ground: "#111113",
  groundRaised: "#1d1e22",
  inkDark: "#9eb1ff", // indigo accent text, dark theme
};

const r = (n) => Math.round(n * 100) / 100;

/**
 * Apple's continuous-corner ("squircle") rounded rect: the curvature ramps in rather
 * than jumping like a circular arc. Constants are the reverse-engineered UIBezierPath
 * continuous-corner control points (corner spans 1.52866483 × radius).
 */
export function squircle(x, y, w, h, radius) {
  const rad = Math.min(radius, Math.min(w, h) / 2 / 1.52866483);
  const tl = (a, b) => `${r(x + a * rad)} ${r(y + b * rad)}`;
  const tr = (a, b) => `${r(x + w - a * rad)} ${r(y + b * rad)}`;
  const br = (a, b) => `${r(x + w - a * rad)} ${r(y + h - b * rad)}`;
  const bl = (a, b) => `${r(x + a * rad)} ${r(y + h - b * rad)}`;
  return [
    `M${tl(1.52866483, 0)}`,
    `L${tr(1.52866471, 0)}`,
    `C${tr(1.08849323, 0)} ${tr(0.86840689, 0)} ${tr(0.66993427, 0.065496)}`,
    `L${tr(0.63149399, 0.074911)}`,
    `C${tr(0.37282392, 0.16906013)} ${tr(0.16906013, 0.37282392)} ${tr(0.074911, 0.63149399)}`,
    `C${tr(0, 0.86840701)} ${tr(0, 1.08849299)} ${tr(0, 1.52866483)}`,
    `L${br(0, 1.52866471)}`,
    `C${br(0, 1.08849323)} ${br(0, 0.86840689)} ${br(0.06549569, 0.66993493)}`,
    `L${br(0.074911, 0.63149399)}`,
    `C${br(0.16906013, 0.37282392)} ${br(0.37282392, 0.16906013)} ${br(0.63149399, 0.074911)}`,
    `C${br(0.86840701, 0)} ${br(1.08849299, 0)} ${br(1.52866483, 0)}`,
    `L${bl(1.52866471, 0)}`,
    `C${bl(1.08849323, 0)} ${bl(0.86840689, 0)} ${bl(0.66993427, 0.065496)}`,
    `L${bl(0.63149399, 0.074911)}`,
    `C${bl(0.37282392, 0.16906013)} ${bl(0.16906013, 0.37282392)} ${bl(0.074911, 0.63149399)}`,
    `C${bl(0, 0.86840701)} ${bl(0, 1.08849299)} ${bl(0, 1.52866483)}`,
    `L${tl(0, 1.52866471)}`,
    `C${tl(0, 1.08849323)} ${tl(0, 0.86840689)} ${tl(0.065496, 0.66993427)}`,
    `L${tl(0.074911, 0.63149399)}`,
    `C${tl(0.16906013, 0.37282392)} ${tl(0.37282392, 0.16906013)} ${tl(0.63149399, 0.074911)}`,
    `C${tl(0.86840701, 0)} ${tl(1.08849299, 0)} ${tl(1.52866483, 0)}`,
    "Z",
  ].join(" ");
}

/**
 * Transform that places キ with its optical centre on (cx, cy) at a given cap height.
 * キ is top-heavy (both bars sit in the upper half), so centring the bounding box
 * leaves it looking high. Vertically we centre on the ink centroid, lifted a hair
 * (1% of the height) because the eye reads the optical middle slightly above the
 * true middle. Horizontally we split the difference between bbox and centroid, since
 * the leaning stem pulls the centroid left of where it looks centred.
 */
export function placeGlyph({ cx, cy, height, weight = "W8" }) {
  const g = KI[weight];
  const [x0, y0, x1, y1] = g.bbox;
  const s = height / (y1 - y0);
  const ax = ((x0 + x1) / 2 + g.centroid[0]) / 2;
  const ay = g.centroid[1] + 0.01 * (y1 - y0);
  return { d: g.d, transform: `translate(${r(cx - ax * s)} ${r(cy - ay * s)}) scale(${r(s * 10000) / 10000})` };
}

const svg = (w, h, body, extra = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"${extra}>\n${body}\n</svg>\n`;

const glyphPath = (p, attrs) => `  <path transform="${p.transform}" d="${p.d}" ${attrs}/>`;

/**
 * Four corner brackets around the glyph: a viewfinder / shutter reticle that hints at
 * the OCR capture. All sizes are fractions of the tile width `w`. Weight and inset are
 * tuned so the strokes stay a solid ~1.2px at a 32px icon (thinner ones dissolved into
 * noise there); below ~24px the brackets fade into texture and the キ carries it.
 */
export const RETICLE = {
  half: 0.335, // centre to bracket corner (sets the inset from the tile edge)
  arm: 0.115, // length of each bracket leg
  stroke: 0.046, // line weight
  opacity: 0.82, // a step behind the glyph
};

function reticlePath({ cx, cy, w, half, arm, stroke, opacity }, attrs) {
  const [h, a] = [half * w, arm * w];
  const [l, t, rr, b] = [cx - h, cy - h, cx + h, cy + h].map(r);
  const A = r(a);
  const d = [
    `M${l} ${r(t + A)}V${t}H${r(l + A)}`,
    `M${r(rr - A)} ${t}H${rr}V${r(t + A)}`,
    `M${rr} ${r(b - A)}V${b}H${r(rr - A)}`,
    `M${r(l + A)} ${b}H${l}V${r(b - A)}`,
  ].join(" ");
  return `  <path d="${d}" stroke-width="${r(stroke * w)}" stroke-opacity="${opacity}" stroke-linecap="round" stroke-linejoin="round" ${attrs}/>`;
}

/** The indigo tile, glyph and finish shared by every coloured variant. */
function tile({ shape, box, glyphHeight, gradient = "vertical", id = "k", shadow = false, edge = true, reticle = null, motif = null }) {
  const [bx, by, bw, bh] = box;
  const grad =
    gradient === "diagonal"
      ? `x1="${bx}" y1="${by}" x2="${bx + bw}" y2="${by + bh}"`
      : `x1="0" y1="${by}" x2="0" y2="${by + bh}"`;
  const glyph = placeGlyph({ cx: bx + bw / 2, cy: by + bh / 2, height: glyphHeight });
  const defs = [
    `    <linearGradient id="${id}-fill" gradientUnits="userSpaceOnUse" ${grad}>`,
    `      <stop offset="0" stop-color="${C.light}"/>`,
    `      <stop offset="0.45" stop-color="${C.accent}"/>`,
    `      <stop offset="1" stop-color="${C.deep}"/>`,
    `    </linearGradient>`,
    // Faint top highlight, gone by mid-tile.
    `    <linearGradient id="${id}-sheen" gradientUnits="userSpaceOnUse" x1="0" y1="${by}" x2="0" y2="${by + bh * 0.55}">`,
    `      <stop offset="0" stop-color="#fff" stop-opacity="0.1"/>`,
    `      <stop offset="1" stop-color="#fff" stop-opacity="0"/>`,
    `    </linearGradient>`,
    // Hairline catch-light along the top edge (inner half of a stroke, clipped).
    `    <linearGradient id="${id}-edge" gradientUnits="userSpaceOnUse" x1="0" y1="${by}" x2="0" y2="${by + bh * 0.3}">`,
    `      <stop offset="0" stop-color="#fff" stop-opacity="0.35"/>`,
    `      <stop offset="1" stop-color="#fff" stop-opacity="0"/>`,
    `    </linearGradient>`,
    `    <linearGradient id="${id}-glyph" gradientUnits="userSpaceOnUse" x1="0" y1="${by + bh * 0.2}" x2="0" y2="${by + bh * 0.8}">`,
    `      <stop offset="0" stop-color="#ffffff"/>`,
    `      <stop offset="1" stop-color="#e9edfc"/>`,
    `    </linearGradient>`,
    `    <clipPath id="${id}-clip"><path d="${shape}"/></clipPath>`,
    `    <filter id="${id}-lift" x="-20%" y="-20%" width="140%" height="140%">`,
    `      <feDropShadow dx="0" dy="${r(bh * 0.008)}" stdDeviation="${r(bh * 0.012)}" flood-color="#1a2c80" flood-opacity="0.35"/>`,
    `    </filter>`,
  ];
  if (shadow) {
    // Apple's Big Sur-era template: a soft shadow under the tile, ~10px drop, 30% black.
    defs.push(
      `    <filter id="${id}-shadow" x="-10%" y="-10%" width="120%" height="125%">`,
      `      <feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="#000" flood-opacity="0.3"/>`,
      `    </filter>`,
    );
  }
  const body = [
    `  <defs>\n${defs.join("\n")}\n  </defs>`,
    `  <path d="${shape}" fill="url(#${id}-fill)"${shadow ? ` filter="url(#${id}-shadow)"` : ""}/>`,
    `  <g clip-path="url(#${id}-clip)">`,
    `    <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="url(#${id}-sheen)"/>`,
    edge ? `    <path d="${shape}" fill="none" stroke="url(#${id}-edge)" stroke-width="${r(bw * 0.006)}"/>` : "",
    motif ? motif({ bx, by, bw, bh, id }) : "",
    `  </g>`,
    reticle ? reticlePath({ cx: bx + bw / 2, cy: by + bh / 2, w: bw, ...reticle }, `fill="none" stroke="#fff" filter="url(#${id}-lift)"`) : "",
    glyphPath(glyph, `fill="url(#${id}-glyph)" filter="url(#${id}-lift)"`),
  ];
  return body.filter(Boolean).join("\n");
}

// Geometry. macOS: Apple's grid puts an 824px squircle (radius ≈ 185) centred in the
// 1024 canvas, leaving 100px around it for the shadow. Full-bleed variants use the
// whole canvas.
const MAC_BOX = [100, 100, 824, 824];
const MAC_RADIUS = 185.4;
const FULL_BOX = [0, 0, 1024, 1024];
const FULL_RADIUS = 1024 * (185.4 / 824);

const files = {};

// Shipped design: キ inside four corner brackets (owner's pick, from sketch "d-scan"
// minus its scan line). The glyph shrinks from 0.54 to 0.44 of the tile to leave air
// inside the reticle.
const GLYPH = 0.44;

files["icon.svg"] = svg(
  1024,
  1024,
  tile({ shape: squircle(...FULL_BOX, FULL_RADIUS), box: FULL_BOX, glyphHeight: 1024 * GLYPH, reticle: RETICLE }),
);

files["icon-macos.svg"] = svg(
  1024,
  1024,
  tile({ shape: squircle(...MAC_BOX, MAC_RADIUS), box: MAC_BOX, glyphHeight: 824 * GLYPH, shadow: true, reticle: RETICLE }),
);

// Windows / Linux / web: full-bleed square. Everything scales off the full 1024 width,
// so glyph and brackets come out ~24% larger than on the macOS tile, which helps at
// 16px and 24px taskbar sizes.
files["icon-square.svg"] = svg(
  1024,
  1024,
  tile({ shape: "M0 0H1024V1024H0Z", box: FULL_BOX, glyphHeight: 1024 * GLYPH, edge: false, reticle: RETICLE }),
);

// Glyph-only, monochrome. No brackets: at favicon/menu-bar sizes they would squeeze
// the キ to ~7px and turn to fuzz. currentColor when inlined; standalone (favicon) it picks the
// indigo accent per colour scheme via the embedded style.
const mono = placeGlyph({ cx: 512, cy: 512, height: 1024 * 0.92 });
files["favicon.svg"] = svg(
  1024,
  1024,
  [
    `  <style>.kimochi-ki{color:${C.accent}}@media (prefers-color-scheme:dark){.kimochi-ki{color:${C.inkDark}}}</style>`,
    glyphPath(mono, `fill="currentColor"`),
  ].join("\n"),
  ` class="kimochi-ki"`,
);

// Menu bar template: the icon without its tile or colour, pure black on transparent so macOS
// recolours it for the menu bar. An 18pt canvas drawn in 2x pixels (36 units): the brackets are
// 2 units wide on even edges, so they land on whole pixels at 1x as well as 2x and stay sharp on
// a non-Retina screen. The arms are longer than the tile's, which at this size would be dots.
{
  const [l, t, rr, b, arm] = [3, 3, 33, 33, 7];
  const brackets = [
    `M${l} ${t + arm}V${t}H${l + arm}`,
    `M${rr - arm} ${t}H${rr}V${t + arm}`,
    `M${rr} ${b - arm}V${b}H${rr - arm}`,
    `M${l + arm} ${b}H${l}V${b - arm}`,
  ].join(" ");
  files["tray-template.svg"] = svg(
    36,
    36,
    [
      `  <path d="${brackets}" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
      glyphPath(placeGlyph({ cx: 18, cy: 18, height: 20 }), `fill="#000"`),
    ].join("\n"),
  );
}

// ---- Sketches for comparison ---------------------------------------------------

files["sketches/0-final-macos.svg"] = files["icon-macos.svg"];
files["sketches/0-final-square.svg"] = files["icon-square.svg"];

files["sketches/a-vertical.svg"] = svg(
  1024,
  1024,
  tile({ shape: squircle(...MAC_BOX, MAC_RADIUS), box: MAC_BOX, glyphHeight: 824 * 0.54, shadow: true }),
);

files["sketches/b-diagonal.svg"] = svg(
  1024,
  1024,
  tile({ shape: squircle(...MAC_BOX, MAC_RADIUS), box: MAC_BOX, glyphHeight: 824 * 0.54, shadow: true, gradient: "diagonal" }),
);

// Dark ground, indigo glyph: the Hangar register, inverted.
{
  const id = "d";
  const shape = squircle(...MAC_BOX, MAC_RADIUS);
  const g = placeGlyph({ cx: 512, cy: 512, height: 824 * 0.54 });
  files["sketches/c-dark.svg"] = svg(
    1024,
    1024,
    [
      `  <defs>`,
      `    <linearGradient id="${id}-fill" gradientUnits="userSpaceOnUse" x1="0" y1="100" x2="0" y2="924">`,
      `      <stop offset="0" stop-color="${C.groundRaised}"/>`,
      `      <stop offset="1" stop-color="${C.ground}"/>`,
      `    </linearGradient>`,
      `    <linearGradient id="${id}-glyph" gradientUnits="userSpaceOnUse" x1="0" y1="280" x2="0" y2="760">`,
      `      <stop offset="0" stop-color="#7d97f5"/>`,
      `      <stop offset="1" stop-color="${C.accent}"/>`,
      `    </linearGradient>`,
      `    <linearGradient id="${id}-edge" gradientUnits="userSpaceOnUse" x1="0" y1="100" x2="0" y2="400">`,
      `      <stop offset="0" stop-color="#fff" stop-opacity="0.18"/>`,
      `      <stop offset="1" stop-color="#fff" stop-opacity="0"/>`,
      `    </linearGradient>`,
      `    <clipPath id="${id}-clip"><path d="${shape}"/></clipPath>`,
      `    <filter id="${id}-shadow" x="-10%" y="-10%" width="120%" height="125%">`,
      `      <feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="#000" flood-opacity="0.3"/>`,
      `    </filter>`,
      `  </defs>`,
      `  <path d="${shape}" fill="url(#${id}-fill)" filter="url(#${id}-shadow)"/>`,
      `  <path d="${shape}" fill="none" stroke="url(#${id}-edge)" stroke-width="5" clip-path="url(#${id}-clip)"/>`,
      glyphPath(g, `fill="url(#${id}-glyph)"`),
    ].join("\n"),
  );
}

files["sketches/e-mono.svg"] = svg(
  1024,
  1024,
  glyphPath(placeGlyph({ cx: 512, cy: 512, height: 1024 * 0.8 }), `fill="${C.accent}"`),
);

for (const [name, content] of Object.entries(files)) {
  const out = join(here, name);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, content);
  console.log(`wrote branding/${name}`);
}

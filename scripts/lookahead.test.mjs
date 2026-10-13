/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS test helpers. */
/**
 * The word-mode lookahead: the following chunks' text, carried after each OCR box so a
 * dictionary lookup can run past a word that cloud OCR split in two (食べ|ました).
 *
 * The renderer tests use the same fake DOM as render-stability.test.mjs. The scanner tests
 * run the *vendored* Yomitan `DOMTextScanner` over the tree the renderer built, with
 * `getComputedStyle` answering from overlay.html's own rules, so a stylesheet change that
 * hides the lookahead from the scanner again (as `opacity: 0; font-size: 0` did) fails here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { load } from "./load.mjs";

function element(tag = "div") {
  return {
    tag,
    children: [],
    style: {
      setProperty(k, v) {
        this[k] = v;
      },
    },
    dataset: {},
    className: "",
    textContent: "",
    listeners: {},
    classList: { add() {} },
    addEventListener(k, f) {
      this.listeners[k] = f;
    },
    append(...nodes) {
      for (const n of nodes) {
        n.remove?.();
        this.children.push(n);
        n.parent = this;
      }
    },
    insertBefore(n, next) {
      n.remove?.();
      const i = next ? this.children.indexOf(next) : this.children.length;
      this.children.splice(i, 0, n);
      n.parent = this;
    },
    remove() {
      if (this.parent) {
        this.parent.children.splice(this.parent.children.indexOf(this), 1);
        this.parent = null;
      }
    },
    replaceChildren() {
      for (const n of [...this.children]) n.remove();
    },
    querySelector(selector) {
      for (const n of this.children) {
        if (n.className === selector.slice(1)) return n;
        const found = n.querySelector?.(selector);
        if (found) return found;
      }
      return null;
    },
  };
}

let selection = null;
globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  getSelection: () => selection,
  getComputedStyle: (node) => computedStyle(node),
};
globalThis.document = {
  addEventListener() {},
  removeEventListener() {},
  createElement: element,
  createDocumentFragment: () => element("fragment"),
  createTextNode: (text) => ({ ...element("text"), textContent: text }),
};
globalThis.requestAnimationFrame = () => 1;

const {
  TextOverlayRenderer,
  readingSuccessors,
  lookaheadTexts,
  selectionExtension,
} = await load("render.js");
const { DOMTextScanner } =
  await import("../extensions/yomitan/js/dom/dom-text-scanner.js");

// --- the renderer ----------------------------------------------------------------

const chunk = (text, x, y, extras = {}, w = 30, h = 20) => ({
  description: text,
  boundingPoly: {
    vertices: [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ],
  },
  ...extras,
});
const info = {
  full_width: 400,
  full_height: 300,
  crop_pixels: [0, 0, 400, 300],
  source_bounds: { x: 0, y: 0, width: 400, height: 300 },
};
const view = (
  chunks,
  grouping = { enabled: false, filterSmallText: false },
) => ({
  annotations: [chunk("aggregate", 0, 0), ...chunks],
  info,
  origin: { x: 0, y: 0, width: 400, height: 300 },
  grouping,
  opacity: 60,
  scanning: false,
});
const lookaheadOf = (host, text) =>
  host.children
    .find((box) => box.querySelector(".ocr-word-current").textContent === text)
    .querySelector(".ocr-lookahead").textContent;

// Two lines of horizontal text, delivered out of reading order, as a cloud engine may.
const horizontal = [
  chunk("ている", 40, 40, { groupId: "p" }),
  chunk("食べ", 0, 0, { groupId: "p" }),
  chunk("走っ", 0, 40, { groupId: "p" }),
  chunk("ました", 40, 0, { groupId: "p" }),
];

test("words mode: the lookahead holds the following chunks in reading order, joined with nothing", () => {
  const host = element();
  new TextOverlayRenderer(host).render(view(horizontal));
  assert.equal(lookaheadOf(host, "食べ"), "ました走っている");
  assert.equal(lookaheadOf(host, "ました"), "走っている");
  assert.equal(lookaheadOf(host, "走っ"), "ている");
});

test("words mode: vertical text reads columns right to left, each top to bottom", () => {
  const host = element();
  const tall = { groupId: "v", orientation: "vertical", isVertical: true };
  new TextOverlayRenderer(host).render(
    view([
      chunk("語", 60, 40, tall, 20, 30),
      chunk("ました", 100, 40, tall, 20, 30),
      chunk("日本", 60, 0, tall, 20, 30),
      chunk("食べ", 100, 0, tall, 20, 30),
    ]),
  );
  assert.equal(lookaheadOf(host, "食べ"), "ました日本語");
  assert.equal(lookaheadOf(host, "日本"), "語");
});

test("words mode: the last chunk of a paragraph has an empty lookahead", () => {
  const host = element();
  new TextOverlayRenderer(host).render(view(horizontal));
  assert.equal(lookaheadOf(host, "ている"), "");
});

test("words mode: a lookahead never runs into another paragraph", () => {
  const host = element();
  new TextOverlayRenderer(host).render(
    view([
      chunk("食べ", 0, 0, { groupId: "a" }),
      chunk("ました", 40, 0, { groupId: "b" }),
    ]),
  );
  assert.equal(lookaheadOf(host, "食べ"), "");
});

test("words mode: the lookahead stops after ten chunks", () => {
  const chunks = [..."あいうえおかきくけこさし"].map((c, i) =>
    chunk(c, i * 30, 0, { groupId: "p" }, 25),
  );
  const next = readingSuccessors(
    chunks.map((c, i) => ({
      text: c.description,
      x: i * 30,
      y: 0,
      width: 25,
      height: 20,
      groupId: "p",
    })),
  );
  const texts = lookaheadTexts(
    chunks.map((c) => ({ text: c.description })),
    next,
  );
  assert.equal(texts[0], "いうえおかきくけこさ");
  assert.equal(texts.at(-1), "");
});

test("groups mode keeps the lookahead empty: a semantic group never extends into another", () => {
  const host = element();
  new TextOverlayRenderer(host).render(
    view(horizontal, { enabled: true, proximityThreshold: 100 }),
  );
  assert.ok(host.children.length > 0);
  for (const group of host.children)
    assert.equal(group.querySelector(".ocr-lookahead").textContent, "");
});

test("a retained box has its lookahead updated in place when the following text changes", () => {
  const host = element();
  const renderer = new TextOverlayRenderer(host);
  renderer.render(
    view([
      chunk("食べ", 0, 0, { groupId: "p" }),
      chunk("ました", 40, 0, { groupId: "p" }),
    ]),
  );
  const box = host.children[0];
  const ahead = box.querySelector(".ocr-lookahead");
  renderer.render(
    view([
      chunk("食べ", 0, 0, { groupId: "p" }),
      chunk("ます", 40, 0, { groupId: "p" }),
    ]),
  );
  assert.equal(host.children[0], box);
  assert.equal(box.querySelector(".ocr-lookahead"), ahead);
  assert.equal(ahead.textContent, "ます");
});

/** The rendered box whose own text is `text`. */
const boxOf = (host, text) =>
  host.children.find(
    (box) => box.querySelector(".ocr-word-current").textContent === text,
  );
/** Stand in for a selection Yomitan made: anchored in the text node of `box`. */
function select(renderer, box, text) {
  selection = text
    ? { toString: () => text, anchorNode: { nodeType: 1, closest: () => box } }
    : null;
  renderer.updateSelectionHighlight();
}
const marks = (box) => ({
  ext: box.querySelector(".ocr-word-current").dataset.ext,
  extended: "extended" in box.dataset,
  consumed: "consumed" in box.dataset,
});

test("a selection that ran into the lookahead lights only the box it started in and hides the boxes it swallowed", () => {
  const host = element();
  const renderer = new TextOverlayRenderer(host);
  renderer.render(view(horizontal));
  select(renderer, boxOf(host, "食べ"), "食べました走っ");
  const lit = [...renderer.selectionIndices].map(
    (i) => renderer.words[i].box.text,
  );
  assert.deepEqual(lit, ["食べ"]);
  const hidden = [...renderer.consumedIndices]
    .map((i) => renderer.words[i].box.text)
    .sort();
  assert.deepEqual(hidden, ["ました", "走っ"].sort());
  select(renderer, null, null);
});

// --- showing the selected word on one box ---------------------------------------

test("selectionExtension: a selection of exactly the box's text extends nothing and hides nothing", () => {
  const words = [
    { text: "食べ", next: 1 },
    { text: "ました", next: 2 },
    { text: "走っ", next: -1 },
  ];
  assert.deepEqual(selectionExtension("食べ", 0, words), {
    extension: "",
    consumed: [],
  });
});

test("selectionExtension: a selection spanning one or two whole successors shows them and hides them", () => {
  const words = [
    { text: "食べ", next: 1 },
    { text: "ました", next: 2 },
    { text: "走っ", next: 3 },
    { text: "ている", next: -1 },
  ];
  assert.deepEqual(selectionExtension("食べました", 0, words), {
    extension: "ました",
    consumed: [1],
  });
  assert.deepEqual(selectionExtension("食べました走っ", 0, words), {
    extension: "ました走っ",
    consumed: [1, 2],
  });
});

test("selectionExtension: a selection ending inside a successor shows the part it took but leaves that box", () => {
  const words = [
    { text: "食べ", next: 1 },
    { text: "ました", next: 2 },
    { text: "走っ", next: -1 },
  ];
  assert.deepEqual(selectionExtension("食べまし", 0, words), {
    extension: "まし",
    consumed: [],
  });
  assert.deepEqual(selectionExtension("食べました走", 0, words), {
    extension: "ました走",
    consumed: [1],
  });
});

test("selectionExtension: follows reading order, not array order", () => {
  // Array order ました, 食べ: the successor chain is what matters.
  const words = [
    { text: "ました", next: -1 },
    { text: "食べ", next: 0 },
  ];
  assert.deepEqual(selectionExtension("食べました", 1, words), {
    extension: "ました",
    consumed: [0],
  });
});

test("selectionExtension: does nothing for a selection that does not start with the box's text, or no box", () => {
  const words = [
    { text: "食べ", next: 1 },
    { text: "ました", next: -1 },
  ];
  const none = { extension: "", consumed: [] };
  assert.deepEqual(selectionExtension("ました", 0, words), none);
  assert.deepEqual(selectionExtension("", 0, words), none);
  assert.deepEqual(selectionExtension("食べました", -1, words), none);
  assert.deepEqual(selectionExtension("食べました", 5, words), none);
});

test("the box a selection starts in carries the extension and the swallowed boxes are marked hidden, until it clears", () => {
  const host = element();
  const renderer = new TextOverlayRenderer(host);
  renderer.render(view(horizontal));
  const stem = boxOf(host, "食べ");
  const ending = boxOf(host, "ました");
  const after = boxOf(host, "走っ");

  select(renderer, stem, "食べました");
  assert.deepEqual(marks(stem), { ext: "ました", extended: true, consumed: false });
  assert.deepEqual(marks(ending), { ext: undefined, extended: false, consumed: true });
  assert.deepEqual(marks(after), { ext: undefined, extended: false, consumed: false });
  // The stem is lit and aligned from its start; the hidden box is not lit.
  renderer.updateProximity();
  assert.equal(stem.style.transform, "scale(1.2)");
  assert.equal(stem.style.transformOrigin, "left center");
  assert.equal(stem.querySelector(".ocr-word-current").style.textAlign, "left");
  assert.equal(ending.style.transform, "scale(1)");
  // Text nodes are untouched: Yomitan's Range lives in them.
  assert.equal(stem.querySelector(".ocr-word-current").textContent, "食べ");
  assert.equal(stem.querySelector(".ocr-lookahead").textContent, "ました走っている");

  select(renderer, null, null);
  const clear = { ext: undefined, extended: false, consumed: false };
  assert.deepEqual(marks(stem), clear);
  assert.deepEqual(marks(ending), clear);
  assert.equal(renderer.selectionIndices.size, 0);
  assert.equal(renderer.consumedIndices.size, 0);
  assert.equal(renderer.extension, null);
  renderer.updateProximity();
  assert.equal(stem.style.transformOrigin, "center");
});

test("a selection ending inside a successor leaves that box visible", () => {
  const host = element();
  const renderer = new TextOverlayRenderer(host);
  renderer.render(view(horizontal));
  select(renderer, boxOf(host, "食べ"), "食べまし");
  assert.deepEqual(marks(boxOf(host, "食べ")), { ext: "まし", extended: true, consumed: false });
  assert.deepEqual(marks(boxOf(host, "ました")), { ext: undefined, extended: false, consumed: false });
  select(renderer, null, null);
});

test("a selection anchored outside any box, or not starting with its box's text, marks nothing", () => {
  const host = element();
  const renderer = new TextOverlayRenderer(host);
  renderer.render(view(horizontal));
  select(renderer, null, "食べました");
  assert.equal(renderer.extension, null);
  assert.equal(renderer.selectionIndices.size, 0);
  select(renderer, boxOf(host, "ました"), "食べました");
  assert.equal(renderer.extension, null);
  assert.equal(renderer.selectionIndices.size, 0);
  select(renderer, null, null);
});

test("vertical boxes extend the same way, scaled from their top", () => {
  const host = element();
  const renderer = new TextOverlayRenderer(host);
  const tall = { groupId: "v", orientation: "vertical", isVertical: true };
  renderer.render(
    view([
      chunk("語", 60, 40, tall, 20, 30),
      chunk("ました", 100, 40, tall, 20, 30),
      chunk("日本", 60, 0, tall, 20, 30),
      chunk("食べ", 100, 0, tall, 20, 30),
    ]),
  );
  const stem = boxOf(host, "食べ");
  select(renderer, stem, "食べました");
  assert.deepEqual(marks(stem), { ext: "ました", extended: true, consumed: false });
  assert.deepEqual(marks(boxOf(host, "ました")), { ext: undefined, extended: false, consumed: true });
  assert.deepEqual(marks(boxOf(host, "日本")), { ext: undefined, extended: false, consumed: false });
  renderer.updateProximity();
  assert.equal(stem.style.transformOrigin, "center top");
  assert.equal(stem.style["--ocr-height"], "30px");
  select(renderer, null, null);
});

test("the marks follow retained boxes through a re-render and clear afterwards", () => {
  const host = element();
  const renderer = new TextOverlayRenderer(host);
  renderer.render(
    view([
      chunk("食べ", 0, 0, { groupId: "p" }),
      chunk("ました", 40, 0, { groupId: "p" }),
      chunk("HP12", 200, 0, { groupId: "hud" }),
    ]),
  );
  const stem = boxOf(host, "食べ");
  const ending = boxOf(host, "ました");
  select(renderer, stem, "食べました");
  renderer.render(
    view([
      chunk("食べ", 0, 0, { groupId: "p" }),
      chunk("ました", 40, 0, { groupId: "p" }),
      chunk("HP11", 200, 0, { groupId: "hud" }),
    ]),
  );
  assert.equal(boxOf(host, "食べ"), stem);
  assert.deepEqual(marks(stem), { ext: "ました", extended: true, consumed: false });
  assert.deepEqual(marks(ending), { ext: undefined, extended: false, consumed: true });
  assert.deepEqual(renderer.extension, { index: 0, text: "ました" });
  // The box it started in is gone: nothing is left extended or hidden.
  renderer.render(
    view([
      chunk("ました", 40, 0, { groupId: "p" }),
      chunk("HP11", 200, 0, { groupId: "hud" }),
    ]),
  );
  assert.equal(renderer.extension, null);
  assert.deepEqual(marks(ending), { ext: undefined, extended: false, consumed: false });
  select(renderer, null, null);
});

test("group mode never extends or hides: its lookahead is empty", () => {
  const host = element();
  const renderer = new TextOverlayRenderer(host);
  renderer.render(view(horizontal, { enabled: true, proximityThreshold: 100 }));
  selection = {
    toString: () => "食べました",
    anchorNode: { nodeType: 1, closest: () => host.children[0] },
  };
  renderer.updateSelectionHighlight();
  selection = null;
  assert.equal(renderer.extension, null);
  assert.equal(renderer.consumedIndices.size, 0);
});

// --- the vendored scanner over the rendered tree -----------------------------------

const overlayHtml = readFileSync(
  new URL("../ui/overlay.html", import.meta.url),
  "utf8",
);

/** Declarations of a single-class rule in overlay.html, e.g. `.ocr-lookahead { ... }`. */
function rule(className, css = overlayHtml) {
  const match = css.match(
    new RegExp(`^\\s*\\.${className}\\s*\\{([^}]*)\\}`, "m"),
  );
  const declarations = {};
  for (const part of (match?.[1] ?? "").split(";")) {
    const at = part.indexOf(":");
    if (at < 0) continue;
    const name = part
      .slice(0, at)
      .trim()
      .replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    declarations[name] = part.slice(at + 1).trim();
  }
  return declarations;
}

/** What a browser would compute for the properties `DOMTextScanner` reads. */
const INHERITED = [
  "fontSize",
  "color",
  "userSelect",
  "webkitUserSelect",
  "visibility",
  "whiteSpace",
];
const ROOT = {
  display: "block",
  position: "static",
  opacity: "1",
  visibility: "visible",
  fontSize: "16px",
  color: "rgb(0, 0, 0)",
  userSelect: "auto",
  webkitUserSelect: "auto",
  whiteSpace: "normal",
};
function normalise(name, value) {
  if (name === "fontSize" && /^0(\.0*)?$/.test(value)) return "0px";
  if (
    (name === "color" || name === "webkitTextFillColor") &&
    value === "transparent"
  )
    return "rgba(0, 0, 0, 0)";
  return value;
}
function computedStyle(node, rules = node.rules) {
  const parent =
    node.parentNode?.nodeType === 1 ? computedStyle(node.parentNode) : ROOT;
  const style = { display: "inline", position: "static", opacity: "1" };
  for (const name of INHERITED) style[name] = parent[name];
  for (const className of node.className.split(/\s+/).filter(Boolean))
    for (const [name, value] of Object.entries(
      rules?.[className] ?? rule(className),
    ))
      style[name] = normalise(name, value);
  for (const [name, value] of Object.entries(node.inline))
    if (typeof value === "string" && value)
      style[name] = normalise(name, value);
  if (style.userSelect !== "auto") style.webkitUserSelect = style.userSelect;
  // A flex item is blockified: the word box is `inline-flex`, so `.ocr-word-text` is a block.
  if (
    /flex/.test(parent.display) &&
    parent !== ROOT &&
    style.display.startsWith("inline")
  )
    style.display = "block";
  return style;
}

/** Turn the renderer's fake elements into the minimal DOM `DOMTextScanner` walks. */
function toDom(fake, parentNode = null, rules) {
  if (fake.tag === "text") return textNode(fake.textContent, parentNode);
  const node = {
    nodeType: 1,
    nodeName: fake.tag === "fragment" ? "DIV" : fake.tag.toUpperCase(),
    className: fake.className,
    inline: fake.style,
    rules,
    parentNode,
    nextSibling: null,
    previousSibling: null,
    childNodes: [],
  };
  const children = fake.children.length
    ? fake.children.map((child) => toDom(child, node, rules))
    : fake.textContent
      ? [textNode(fake.textContent, node)]
      : [];
  link(node, children);
  return node;
}
function textNode(value, parentNode) {
  return {
    nodeType: 3,
    nodeName: "#text",
    nodeValue: value,
    parentNode,
    nextSibling: null,
    previousSibling: null,
    childNodes: [],
  };
}
function link(node, children) {
  node.childNodes = children;
  node.firstChild = children[0] ?? null;
  node.lastChild = children.at(-1) ?? null;
  children.forEach((child, i) => {
    child.parentNode = node;
    child.previousSibling = children[i - 1] ?? null;
    child.nextSibling = children[i + 1] ?? null;
  });
}
const find = (node, className) => {
  if (node.className === className) return node;
  for (const child of node.childNodes) {
    const found = find(child, className);
    if (found) return found;
  }
  return null;
};

/** The rendered overlay for two split words, hovering the first. */
function hovered(rules) {
  const host = element();
  const renderer = new TextOverlayRenderer(host);
  renderer.render(
    view([
      chunk("食べ", 0, 0, { groupId: "p" }),
      chunk("ました", 40, 0, { groupId: "p" }),
    ]),
  );
  renderer.setPointer(10, 10);
  renderer.updateProximity();
  const root = toDom(
    {
      ...element("div"),
      className: "words",
      style: { position: "absolute" },
      children: host.children,
    },
    null,
    rules,
  );
  const first = root.childNodes[0];
  return {
    root,
    current: find(first, "ocr-word-current"),
    lookahead: find(first, "ocr-lookahead"),
  };
}

test("the lookahead rule is one the scanner can see: visible, inline-level, in normal flow", () => {
  const { lookahead } = hovered();
  const style = computedStyle(lookahead);
  assert.equal(
    DOMTextScanner.isStyleVisible(style),
    true,
    JSON.stringify(style),
  );
  assert.equal(style.position, "static");
  assert.equal(DOMTextScanner.doesCSSDisplayChangeLayout(style.display), false);
  assert.deepEqual(DOMTextScanner.getElementSeekInfo(lookahead), {
    enterable: true,
    newlines: 0,
  });
  // Hidden from the reader by geometry, not by any property the scanner reads.
  assert.match(rule("ocr-lookahead").transform ?? "", /scale\(0\)/);
});

test("seeking forward from the end of the hovered word continues into the lookahead", () => {
  const { current } = hovered();
  const text = current.childNodes[0];
  assert.equal(text.nodeValue, "食べ");
  const fromEnd = new DOMTextScanner(
    text,
    text.nodeValue.length,
    false,
    true,
  ).seek(3);
  assert.equal(fromEnd.content, "ました");
  // A lookup the way Yomitan runs it: from the hovered character, layout-aware, scan length 16.
  const lookup = new DOMTextScanner(text, 0, false, true).seek(16);
  assert.equal(lookup.content, "食べました");
});

test("showing the selected word on the hovered box changes nothing the scanner reads", () => {
  // The extension is drawn by `.ocr-word-current[data-ext]::after`, so the only change the
  // DOM sees is an attribute and the sizes that rule sets; apply those sizes here too.
  const shown = {
    "ocr-word-current": {
      ...rule("ocr-word-current"),
      width: "auto",
      minWidth: "30px",
    },
  };
  const host = element();
  const renderer = new TextOverlayRenderer(host);
  renderer.render(
    view([
      chunk("食べ", 0, 0, { groupId: "p" }),
      chunk("ました", 40, 0, { groupId: "p" }),
    ]),
  );
  renderer.setPointer(10, 10);
  renderer.updateProximity();
  select(renderer, host.children[0], "食べました");
  assert.equal(marks(host.children[0]).ext, "ました");
  const root = toDom(
    { ...element("div"), className: "words", style: { position: "absolute" }, children: host.children },
    null,
    shown,
  );
  const current = find(root.childNodes[0], "ocr-word-current");
  // One text node, the box's own text: the extension is not in the tree at all.
  assert.equal(current.childNodes.length, 1);
  assert.equal(current.childNodes[0].nodeValue, "食べ");
  const texts = [];
  (function walk(node) {
    if (node.nodeType === 3) texts.push(node.nodeValue);
    for (const child of node.childNodes) walk(child);
  })(root.childNodes[0]);
  assert.deepEqual(texts, ["食べ", "ました"]);
  assert.equal(DOMTextScanner.isStyleVisible(computedStyle(current)), true);
  assert.equal(
    new DOMTextScanner(current.childNodes[0], 0, false, true).seek(16).content,
    "食べました",
  );
  select(renderer, null, null);
});

test("regression: the old zero-size, zero-opacity lookahead stopped every lookup at the chunk edge", () => {
  const old = {
    "ocr-lookahead": { fontSize: "0px", lineHeight: "0", opacity: "0" },
  };
  const { lookahead, current } = hovered(old);
  assert.deepEqual(DOMTextScanner.getElementSeekInfo(lookahead), {
    enterable: false,
    newlines: 0,
  });
  assert.equal(
    new DOMTextScanner(current.childNodes[0], 0, false, true).seek(16).content,
    "食べ",
  );
  // And absolutely positioned text, the Electron overlay's approach, would end the match too.
  const absolute = { "ocr-lookahead": { position: "absolute" } };
  assert.equal(
    DOMTextScanner.getElementSeekInfo(hovered(absolute).lookahead).newlines,
    2,
  );
});

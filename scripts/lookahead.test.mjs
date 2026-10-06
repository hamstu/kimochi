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

const { TextOverlayRenderer, readingSuccessors, lookaheadTexts } =
  await load("render.js");
const { DOMTextScanner } =
  await import("../yomitan/js/dom/dom-text-scanner.js");

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

test("a selection that ran into the lookahead lights the boxes it covers, in reading order", () => {
  const host = element();
  const renderer = new TextOverlayRenderer(host);
  renderer.render(view(horizontal));
  selection = {
    toString: () => "食べました走っ",
    anchorNode: { nodeType: 1, closest: () => true },
  };
  renderer.updateSelectionHighlight();
  selection = null;
  const lit = [...renderer.selectionIndices]
    .map((i) => renderer.words[i].box.text)
    .sort();
  assert.deepEqual(lit, ["ました", "食べ", "走っ"].sort());
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

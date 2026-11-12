/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS test helpers. */
/**
 * A word the game breaks across two lines is looked up whole in the Text Hooker's card (#114).
 *
 * The card shows a hooked line on as many lines as the game does, broken where the game breaks it
 * (ui/overlay.js `hookCardView` joins the rows OCR found with `\n`; a hooked line can carry the
 * game's own `\n` too). It used to put that `\n` in the page's text, under `white-space: pre-wrap`,
 * and the dictionary reads the page's characters: hovering 自転 of 自転 / 車 looked up `自転\n車`,
 * which only matches 自転. ui/hook-card.js now draws each line as an inline row with a generated
 * line break after it (hook-card.css), so the page holds the line's characters and nothing else.
 *
 * These run ui/hook-card.js over a small fake DOM, then the *vendored* Yomitan `DOMTextScanner`
 * over what it built, with Yomitan's Layout-aware scan off (its default; PR #131 keeps it off on
 * Kimochi's pages) and on, so neither a card change nor a Yomitan update can split the word again
 * unnoticed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { load } from "./load.mjs";

const css = readFileSync(
  new URL("../ui/hook-card.css", import.meta.url),
  "utf8",
);
/** The declarations of `selector`'s first rule in hook-card.css. */
function ruleOf(selector) {
  const at = css.indexOf(`${selector} {`);
  assert.ok(at >= 0, `hook-card.css has no ${selector} rule`);
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
  return Object.fromEntries(
    body
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(";")
      .map((line) => line.split(":").map((part) => part.trim()))
      .filter(([name, value]) => name && value),
  );
}

// --- A small DOM: a real tree (parents, siblings), enough for hook-card.js and the scanner. ----

globalThis.Node ??= { ELEMENT_NODE: 1, TEXT_NODE: 3 };

class FakeText {
  constructor(data) {
    this.nodeType = 3;
    this.nodeName = "#text";
    this.data = data;
    this.parentNode = null;
    this.childNodes = [];
  }
  get nodeValue() {
    return this.data;
  }
  get textContent() {
    return this.data;
  }
  get length() {
    return this.data.length;
  }
  get firstChild() {
    return null;
  }
  get lastChild() {
    return null;
  }
  get nextSibling() {
    return sibling(this, 1);
  }
  get previousSibling() {
    return sibling(this, -1);
  }
}
const sibling = (node, step) =>
  node.parentNode?.childNodes[
    node.parentNode.childNodes.indexOf(node) + step
  ] ?? null;
/** Takes `node` out of its parent, if it has one. */
const detach = (node) => {
  if (!node.parentNode) return;
  node.parentNode.childNodes.splice(
    node.parentNode.childNodes.indexOf(node),
    1,
  );
  node.parentNode = null;
};
/** The next or previous element among `node`'s siblings. */
const elementSibling = (node, step) => {
  for (let next = sibling(node, step); next; next = sibling(next, step))
    if (next.nodeType === 1) return next;
  return null;
};
/** What text and element nodes share: element siblings, and moving themselves within their parent. */
const TREE = {
  get nextElementSibling() {
    return elementSibling(this, 1);
  },
  get previousElementSibling() {
    return elementSibling(this, -1);
  },
  after(...nodes) {
    const parent = this.parentNode;
    const next = this.nextSibling;
    for (const node of nodes) parent.insertBefore(node, next);
  },
  before(...nodes) {
    for (const node of nodes) this.parentNode.insertBefore(node, this);
  },
  remove() {
    detach(this);
  },
};

class FakeElement {
  constructor(tag) {
    this.nodeType = 1;
    this.nodeName = tag.toUpperCase();
    this.className = "";
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = {};
    this.hidden = false;
    this.innerHTML = "";
    this.offsetParent = null;
    const style = { setProperty: (name, value) => (style[name] = value) };
    this.style = style;
    const classes = () => this.className.split(/\s+/).filter(Boolean);
    this.classList = {
      contains: (name) => classes().includes(name),
      add: (name) => this.classList.toggle(name, true),
      remove: (name) => this.classList.toggle(name, false),
      toggle: (name, force = !classes().includes(name)) => {
        const rest = classes().filter((c) => c !== name);
        this.className = (force ? [...rest, name] : rest).join(" ");
        return force;
      },
    };
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get lastChild() {
    return this.childNodes.at(-1) ?? null;
  }
  get nextSibling() {
    return sibling(this, 1);
  }
  get previousSibling() {
    return sibling(this, -1);
  }
  get children() {
    return this.childNodes.filter((node) => node.nodeType === 1);
  }
  get textContent() {
    return this.childNodes.map((node) => node.textContent).join("");
  }
  set textContent(value) {
    this.replaceChildren(
      ...(value === "" ? [] : [new FakeText(String(value))]),
    );
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  toggleAttribute(name, force = !this.attributes.has(name)) {
    if (force) this.attributes.set(name, "");
    else this.attributes.delete(name);
    return force;
  }
  append(...nodes) {
    for (const node of nodes) this.insertBefore(node, null);
  }
  /** Inserts `node` (or a string, as text) before `next`, a child of this; at the end for null. */
  insertBefore(node, next) {
    const child = typeof node === "string" ? new FakeText(node) : node;
    if (child === next) return child;
    detach(child);
    const at = next ? this.childNodes.indexOf(next) : -1;
    if (next && at < 0) throw Error("insertBefore: not a child");
    if (at < 0) this.childNodes.push(child);
    else this.childNodes.splice(at, 0, child);
    child.parentNode = this;
    return child;
  }
  get firstElementChild() {
    return this.children[0] ?? null;
  }
  get lastElementChild() {
    return this.children.at(-1) ?? null;
  }
  cloneNode(deep = false) {
    const copy = new FakeElement(this.nodeName.toLowerCase());
    copy.className = this.className;
    copy.attributes = new Map(this.attributes);
    copy.hidden = this.hidden;
    if (deep)
      for (const child of this.childNodes)
        copy.append(
          child.nodeType === 3
            ? new FakeText(child.data)
            : child.cloneNode(true),
        );
    return copy;
  }
  replaceChildren(...nodes) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  querySelectorAll(selector) {
    const name = selector.replace(/^\./, "");
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.classList.contains(name)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  addEventListener() {}
  getAnimations() {
    return [];
  }
}

for (const kind of [FakeText, FakeElement])
  Object.defineProperties(
    kind.prototype,
    Object.getOwnPropertyDescriptors(TREE),
  );

globalThis.document = { createElement: (tag) => new FakeElement(tag) };
globalThis.innerWidth = 1280;
globalThis.innerHeight = 800;
globalThis.addEventListener = () => {};
globalThis.matchMedia = () => ({ matches: true });

/**
 * What a browser computes for the properties `DOMTextScanner` reads: the card is placed absolutely,
 * its text is a block laid out as hook-card.css says, and a row is an inline span.
 */
function computedStyle(element) {
  const parent =
    element.parentNode?.nodeType === 1
      ? computedStyle(element.parentNode)
      : null;
  const style = {
    display: element.nodeName === "SPAN" ? "inline" : "block",
    position: "static",
    visibility: "visible",
    opacity: "1",
    fontSize: "16px",
    color: "rgb(0, 0, 0)",
    userSelect: "auto",
    webkitUserSelect: "auto",
    whiteSpace: parent?.whiteSpace ?? "normal",
  };
  if (element.classList.contains("hook-card")) style.position = "absolute";
  if (element.classList.contains("hook-card-text"))
    style.whiteSpace = ruleOf(".hook-card-text")["white-space"];
  if (element.hidden) style.display = "none";
  return style;
}
globalThis.window = { getComputedStyle: computedStyle };

const { createHookCard } = await load("hook-card.js");
const { DOMTextScanner } =
  await import("../extensions/yomitan/js/dom/dom-text-scanner.js");

const none = () => {};
/** A card in a page, showing `text` as the overlay does. */
function cardShowing(text) {
  const body = new FakeElement("body");
  const card = createHookCard(body, {
    onMoved: none,
    onDrag: none,
    onTextSize: none,
    onOpacity: none,
    onSettings: none,
  });
  card.show({
    text,
    x: 100,
    y: 500,
    width: 260,
    height: 72,
    fontPx: 24,
    lineHeight: 1.5,
    theme: "dark",
    opacity: 1,
  });
  // Something after the card in the page, as the overlay has (the hover layer, the controller).
  body.append(new FakeElement("div"));
  return { card, body, text: card.element.querySelector(".hook-card-text") };
}
/** Text nodes under `node`, in document order. */
const textNodes = (node) =>
  node.nodeType === 3 ? [node] : node.childNodes.flatMap(textNodes);

/**
 * What Yomitan's scanner reads from `word` in the card, as `TextSourceRange#setEndOffset` reads
 * for a lookup: Layout-aware scan off forces whitespace to count and adds no line breaks of its
 * own; on, it reads breaks from the page's layout.
 */
function lookupFrom(textElement, word, layoutAwareScan) {
  for (const node of textNodes(textElement)) {
    const at = node.data.indexOf(word);
    if (at >= 0)
      return new DOMTextScanner(
        node,
        at,
        !layoutAwareScan,
        layoutAwareScan,
      ).seek(16).content;
  }
  throw Error(`no ${word} in the card`);
}

const LINE = "今日は自転\n車で行った";

test("a word the game breaks across two lines is read whole, Layout-aware scan on or off", () => {
  const { text } = cardShowing(LINE);
  for (const layoutAwareScan of [false, true]) {
    assert.match(lookupFrom(text, "自転", layoutAwareScan), /^自転車で行った/);
    // From the second row on, as before.
    assert.match(lookupFrom(text, "車", layoutAwareScan), /^車で行った/);
  }
});

test("the card shows each line as a row, with no line break in the page's text", () => {
  const { text } = cardShowing(LINE);
  assert.deepEqual(
    text.children.map((row) => [row.className, row.textContent]),
    [
      ["hook-card-row", "今日は自転"],
      ["hook-card-row", "車で行った"],
    ],
  );
  assert.equal(
    textNodes(text).some((node) => node.data.includes("\n")),
    false,
  );
  // A line with no break is a single row.
  const single = cardShowing("今日は自転車で行った").text;
  assert.deepEqual(
    single.children.map((row) => row.textContent),
    ["今日は自転車で行った"],
  );
});

test("the rows are broken by a generated newline, which the text's white-space keeps", () => {
  assert.equal(
    ruleOf(".hook-card-row:not(:last-child)::after").content,
    "'\\A'",
  );
  assert.match(
    ruleOf(".hook-card-text")["white-space"],
    /^(pre|pre-wrap|pre-line|break-spaces)$/,
  );
});

test("showing another line replaces the rows; the same line again leaves them", () => {
  const { card, text } = cardShowing(LINE);
  const rows = text.children;
  card.show({
    text: LINE,
    x: 100,
    y: 500,
    width: 260,
    height: 72,
    fontPx: 24,
    lineHeight: 1.5,
    theme: "dark",
    opacity: 1,
  });
  assert.deepEqual(text.children, rows);
  // Hidden between (a line replacing a shown one fades over a copy, which needs layout).
  card.show(null);
  card.show({
    text: "猫が\nいる",
    x: 100,
    y: 500,
    width: 260,
    height: 72,
    fontPx: 24,
    lineHeight: 1.5,
    theme: "dark",
    opacity: 1,
  });
  assert.deepEqual(
    text.children.map((row) => row.textContent),
    ["猫が", "いる"],
  );
});

test("a newline in the page's text is what split the word (why the card draws its breaks)", () => {
  // The card as it was: the line as one text node, `\n` and all, under its white-space.
  const text = new FakeElement("div");
  text.className = "hook-card-text";
  text.textContent = LINE;
  for (const layoutAwareScan of [false, true])
    assert.match(lookupFrom(text, "自転", layoutAwareScan), /^自転\n車/);
});

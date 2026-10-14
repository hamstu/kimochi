import test from "node:test";
import assert from "node:assert/strict";
import { historyEntries, historyIndex } from "../ui/controller-history.js";
import { itemFor } from "../ui/radial-menu.js";
test("history ignores malformed and duplicate entries without editing durable text", () => {
  const text = "日本語\n<script>untouched</script>";
  const entry = { id: "a", text };
  const values = [
    null,
    { id: "empty", text: " " },
    entry,
    { id: "a", text: "duplicate" },
    { id: 5, text: "bad" },
  ];
  assert.deepEqual(historyEntries(values), [entry]);
  assert.equal(entry.text, text);
  assert.equal(values.length, 5);
  assert.deepEqual(historyEntries(null), []);
});
test("history is bounded and navigation does not wrap at the ends", () => {
  assert.equal(
    historyEntries(
      Array.from({ length: 100 }, (_, id) => ({ id: String(id), text: "猫" })),
    ).length,
    50,
  );
  assert.equal(historyIndex(0, "up", 3), 0);
  assert.equal(historyIndex(0, "down", 3), 1);
  assert.equal(historyIndex(2, "right", 3), 2);
  assert.equal(historyIndex(2, "left", 3), 1);
  assert.equal(historyIndex(0, "down", 0), -1);
});
test("D-pad can reach every expanded radial action and wrap both directions", () => {
  let current = -1;
  const visited = new Set();
  for (let step = 0; step < 6; step++) {
    current = itemFor("right", 6, current);
    visited.add(current);
  }
  assert.equal(visited.size, 6);
  assert.equal(itemFor("right", 6, current), 0);
  assert.equal(itemFor("left", 6, 0), 5);
  assert.equal(itemFor("invalid", 6, 2), 2);
  assert.equal(itemFor("down", 4, 0), 2);
});

// Exercise the real controller state machine and history DOM together. Geometry is
// deterministic here; native input and dictionary rendering remain device gates.
import { createController } from "../ui/controller.js";

class Element {
  constructor(tag, text = "") {
    this.tagName = tag;
    this.nodeType = tag === "#text" ? 3 : 1;
    this.children = [];
    this.style = { setProperty(name, value) { this[name] = value; } };
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = "";
    this.value = text;
    this.parentElement = null;
    this.classList = {
      add: (...names) => {
        this.className = [
          ...new Set([...this.className.split(" "), ...names]),
        ].join(" ");
      },
      remove: (...names) => {
        this.className = this.className
          .split(" ")
          .filter((name) => !names.includes(name))
          .join(" ");
      },
      contains: (name) => this.className.split(" ").includes(name),
      toggle: (name, enabled) =>
        enabled ? this.classList.add(name) : this.classList.remove(name),
    };
  }
  get childNodes() {
    return this.children;
  }
  get textContent() {
    return (
      this.value + this.children.map((child) => child.textContent).join("")
    );
  }
  set textContent(text) {
    this.replaceChildren();
    this.value = text;
  }
  set innerHTML(value) {
    this.replaceChildren();
    for (const match of value.matchAll(/class="([^"]+)"/g)) {
      const child = new Element('span');
      child.className = match[1];
      this.append(child);
    }
  }
  get length() {
    return this.textContent.length;
  }
  get isConnected() {
    return this.connected || Boolean(this.parentElement?.isConnected);
  }
  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.append(...children);
  }
  remove() {
    if (this.parentElement)
      this.parentElement.children = this.parentElement.children.filter(
        (child) => child !== this,
      );
    this.parentElement = null;
  }
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
  addEventListener(name, fn) {
    this.listeners.set(name, fn);
  }
  scrollIntoView() {}
  scrollBy() {}
  getBoundingClientRect() {
    return { x: 10, y: 20, left: 10, top: 20, width: 240, height: 30 };
  }
  querySelector(selector) {
    if (selector === ".cm-hud-message" && !this.message) {
      this.message = new Element("span");
      this.message.className = "cm-hud-message";
      this.append(this.message);
    }
    return (
      this.children.find((child) =>
        child.classList.contains(selector.slice(1)),
      ) ??
      this.children
        .map((child) => child.querySelector(selector))
        .find(Boolean) ??
      this.message ??
      null
    );
  }
}

function controllerHarness(t, history, overrides = {}) {
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    Node: globalThis.Node,
  };
  globalThis.window = { innerWidth: 1280, innerHeight: 800 };
  globalThis.Node = { TEXT_NODE: 3 };
  globalThis.document = {
    createElement: (tag) => new Element(tag),
    createElementNS: (_, tag) => new Element(tag),
    createTextNode: (text) => new Element("#text", text),
    createRange: () => ({
      setStart(node, offset) {
        this.node = node;
        this.start = offset;
      },
      setEnd(node, offset) {
        this.node = node;
        this.end = offset;
      },
      getClientRects() {
        return [this.getBoundingClientRect()];
      },
      getBoundingClientRect() {
        return {
          left: 10 + this.start * 10,
          top: 20,
          width: (this.end - this.start) * 10,
          height: 30,
        };
      },
      toString() {
        return this.node.textContent.slice(this.start, this.end);
      },
    }),
  };
  const host = new Element("main");
  host.connected = true;
  const words = new Element("div");
  const listeners = new Map();
  const nav = [],
    lookups = [],
    textVisible = [],
    logs = [];
  let scans = 0,
    actions = 0;
  let dictionary = null;
  const controller = createController({
    host,
    words,
    native: {
      listen: (name, fn) => {
        listeners.set(name, fn);
        return Promise.resolve(() => listeners.delete(name));
      },
      controllerNav: async (active) => {
        nav.push(active);
      },
    },
    status: () => ({
      hasText: true,
      autoOcr: false,
      autoAvailable: true,
      textVisible: true,
      center: { x: 640, y: 400 },
      area: null,
      origin: null,
    }),
    history,
    run: () => {
      actions++;
    },
    scan: async () => {
      scans++;
      return true;
    },
    popupControl: () => {},
    redraw: () => {},
    dictionary: () => dictionary,
    buttons: () => ({}),
    popupType: () => "builtin",
    lookupRange: async (range) => {
      lookups.push(range.toString());
      return true;
    },
    dismiss: () => {},
    quietText: () => {},
    setText: async (visible) => {
      textVisible.push(visible);
    },
    nearText: () => false,
    log: (record) => {
      logs.push(record);
    },
    ...overrides,
  });
  t.after(async () => {
    await controller.close();
    Object.assign(globalThis, saved);
  });
  return {
    controller,
    host,
    nav,
    lookups,
    textVisible,
    logs,
    effects: () => ({ scans, actions }),
    setDictionary(api) {
      dictionary = api;
    },
    async press(button) {
      listeners.get("controller-nav")({
        payload: {
          pressed: [button],
          released: [],
          held: [button],
          stick: { x: 0, y: 0 },
          rstick: { x: 0, y: 0 },
        },
      });
      await new Promise((resolve) => setImmediate(resolve));
      listeners.get("controller-nav")({
        payload: {
          pressed: [],
          released: [button],
          held: [],
          stick: { x: 0, y: 0 },
          rstick: { x: 0, y: 0 },
        },
      });
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test("recent text reads archived words, B returns to its list, and B closes without altering the live scan", async (t) => {
  const h = controllerHarness(t, async () => [
    { id: "old", text: "猫 犬", timestamp: 1 },
  ]);
  await h.controller.recentText();
  assert.equal(h.controller.mode, "history");
  assert.deepEqual(h.nav, [true]);
  assert.ok(h.host.textContent.includes("猫 犬"));
  await h.press(0);
  assert.equal(h.controller.mode, "words");
  assert.equal(
    h.controller.holdsText,
    false,
    "archived words do not force live annotations on",
  );
  assert.deepEqual(h.lookups, ["猫 犬"]);
  const lookups = h.lookups.length;
  h.controller.scanChanged(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    h.lookups.length,
    lookups,
    "live scan updates never replace the historical cursor",
  );
  await h.press(15);
  assert.equal(h.lookups.at(-1), "犬");
  await h.press(1);
  assert.equal(h.controller.mode, "history");
  assert.deepEqual(
    h.nav,
    [true],
    "returning to the list retains navigation ownership",
  );
  await h.press(1);
  assert.equal(h.controller.mode, "idle");
  assert.deepEqual(h.nav, [true, false]);
  assert.deepEqual(h.controller.hitRects(), []);
  assert.deepEqual(
    h.textVisible,
    [],
    "closing archived text does not hide the live overlay",
  );
  assert.deepEqual(h.effects(), { scans: 0, actions: 0 });
});

test("history fetched after cancellation cannot reopen the reader or reclaim input", async (t) => {
  let resolveHistory;
  const h = controllerHarness(
    t,
    () =>
      new Promise((resolve) => {
        resolveHistory = resolve;
      }),
  );
  const opening = h.controller.recentText();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.controller.mode, "history");
  await h.controller.close();
  resolveHistory([{ id: "late", text: "古い文字" }]);
  await opening;
  assert.equal(h.controller.mode, "idle");
  assert.deepEqual(h.nav, [true, false]);
  assert.deepEqual(h.controller.hitRects(), []);
  assert.equal(h.host.textContent, "");
});

test("failed history fetch releases navigation ownership and reports the exact failure", async (t) => {
  const h = controllerHarness(t, async () => {
    throw Error("fixture: history read failed");
  });
  await h.controller.recentText();
  assert.equal(h.controller.mode, "idle");
  assert.deepEqual(h.nav, [true, false]);
  assert.deepEqual(h.logs, [
    {
      check: "controller-history-failed",
      error: "fixture: history read failed",
    },
  ]);
});

test("late archived-word segmentation cannot replace the list after B returns to it", async (t) => {
  let finishParse;
  const h = controllerHarness(t, async () => [{ id: "old", text: "猫" }]);
  h.setDictionary(
    () =>
      new Promise((resolve) => {
        finishParse = resolve;
      }),
  );
  await h.controller.recentText();
  await h.press(0);
  assert.equal(h.controller.mode, "words");
  await h.press(1);
  assert.equal(h.controller.mode, "history");
  finishParse([
    { source: "scanning-parser", content: [[{ text: "猫", headwords: [] }]] },
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.controller.mode, "history");
  assert.deepEqual(h.lookups, []);
  assert.deepEqual(h.nav, [true]);
  await h.press(1);
  assert.deepEqual(h.nav, [true, false]);
});

test("Gaming Mode opens controls before releasing radial ownership", async (t) => {
  let panelReady;
  const events = [];
  const h = controllerHarness(t, async () => [], {
    panelInputHandoff: true,
    run: async id => {
      events.push(id);
      await new Promise(resolve => { panelReady = resolve; });
      events.push('panel-focused');
    }
  });
  await h.controller.toggle();
  for (let i = 0; i < 5; i++) await h.press(15);
  await h.press(0);
  assert.deepEqual(events, ['controls']);
  assert.deepEqual(h.nav, [true], 'lease must remain live while panel is opening');
  panelReady();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['controls', 'panel-focused']);
  assert.deepEqual(h.nav, [true, false]);
  assert.equal(h.controller.mode, 'idle');
});
